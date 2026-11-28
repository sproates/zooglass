package io.zooglass.delivery;

import io.zooglass.access.AccessGrant;
import io.zooglass.access.ViewResource;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

/** One finite snapshot. Readiness waits happen outside the guarded chunk handoff. */
final class AuthorisedHttpWriter implements WriteListener, AsyncListener {

    static final int CHUNK_BYTES = 8192;
    private final AsyncContext context;
    private final HttpServletResponse response;
    private final ServletOutputStream output;
    private final Runnable abort;
    private final java.util.function.BooleanSupplier permitted;
    private final String mediaType;
    private final int status;
    private byte[] body;
    private int offset;
    private boolean stopped;
    private Runnable detach = () -> {};
    private boolean headersPrepared;

    AuthorisedHttpWriter(AsyncContext context, HttpServletResponse response, ServletOutputStream output,
            Runnable abort, AccessGrant grant, ViewResource resource, int status, byte[] body) {
        this(context, response, output, abort, () -> grant.permits(resource), "application/json", status, body);
    }

    AuthorisedHttpWriter(AsyncContext context, HttpServletResponse response, ServletOutputStream output,
            Runnable abort, java.util.function.BooleanSupplier permitted, String mediaType, int status, byte[] body) {
        this.context = context;
        this.response = response;
        this.output = output;
        this.abort = abort;
        this.permitted = permitted;
        this.mediaType = mediaType;
        this.status = status;
        this.body = body;
    }

    synchronized void observeRetirement(java.util.function.Function<Runnable, Runnable> observe) {
        if (!stopped) detach = observe.apply(() -> onTimeout(null));
    }

    @Override
    public synchronized void onWritePossible() throws IOException {
        while (!stopped && output.isReady()) {
            if (!headersPrepared) {
                response.setStatus(status);
                response.setContentLength(body.length);
                if (body.length > 0) {
                    response.setContentType(mediaType);
                }
                headersPrepared = true;
            }
            if (!permitted.getAsBoolean()) {
                refuse();
                return;
            }
            int length = Math.min(CHUNK_BYTES, body.length - offset);
            if (length > 0) {
                // Servlet nonblocking mode accepts this bounded chunk without waiting for the peer.
                output.write(body, offset, length);
                offset += length;
            } else {
                // Metadata alone has not been released. Commit it now in nonblocking
                // mode, while the grant is current, rather than during async completion.
                output.flush();
            }
            if (offset == body.length) {
                finish();
            }
        }
    }

    private void refuse() {
        if (response.isCommitted()) {
            abort.run();
        } else {
            response.resetBuffer();
            response.setContentType(null);
            response.setStatus(503);
            response.setContentLength(0);
        }
        finish();
    }

    private void finish() {
        stopped = true;
        body = null;
        detach.run();
        context.complete();
    }

    @Override
    public synchronized void onError(Throwable failure) {
        if (!stopped) {
            abort.run();
            finish();
        }
    }

    @Override
    public synchronized void onTimeout(AsyncEvent event) {
        if (!stopped) {
            refuse();
        }
    }

    @Override
    public synchronized void onComplete(AsyncEvent event) {
        detach.run();
        stopped = true;
        body = null;
    }

    @Override
    public void onError(AsyncEvent event) {
        onError(event.getThrowable());
    }

    @Override
    public void onStartAsync(AsyncEvent event) {}
}
