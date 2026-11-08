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
    private final AccessGrant grant;
    private final ViewResource resource;
    private final int status;
    private byte[] body;
    private int offset;
    private boolean stopped;
    private boolean headersPrepared;

    AuthorisedHttpWriter(AsyncContext context, HttpServletResponse response, ServletOutputStream output,
            Runnable abort, AccessGrant grant, ViewResource resource, int status, byte[] body) {
        this.context = context;
        this.response = response;
        this.output = output;
        this.abort = abort;
        this.grant = grant;
        this.resource = resource;
        this.status = status;
        this.body = body;
    }

    @Override
    public synchronized void onWritePossible() throws IOException {
        while (!stopped && output.isReady()) {
            if (!grant.permits(resource)) {
                refuse();
                return;
            }
            if (!headersPrepared) {
                response.setStatus(status);
                response.setContentLength(body.length);
                if (body.length > 0) {
                    response.setContentType("application/json");
                }
                headersPrepared = true;
            }
            int length = Math.min(CHUNK_BYTES, body.length - offset);
            if (length > 0) {
                // Servlet nonblocking mode accepts this bounded chunk without waiting for the peer.
                output.write(body, offset, length);
                offset += length;
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
            response.setStatus(503);
            response.setContentLength(0);
        }
        finish();
    }

    private void finish() {
        stopped = true;
        body = null;
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
