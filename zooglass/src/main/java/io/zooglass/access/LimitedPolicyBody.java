package io.zooglass.access;

import java.io.IOException;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/** Cancels oversized replies before buffering them, including chunked responses. */
final class LimitedPolicyBody implements HttpResponse.BodySubscriber<byte[]> {

    static final int MAX_BYTES = 16 * 1024;
    private final HttpResponse.BodySubscriber<byte[]> delegate = HttpResponse.BodySubscribers.ofByteArray();
    private Flow.Subscription subscription;
    private int received;
    private boolean failed;

    @Override
    public CompletionStage<byte[]> getBody() {
        return delegate.getBody();
    }

    @Override
    public void onSubscribe(Flow.Subscription subscription) {
        this.subscription = subscription;
        delegate.onSubscribe(subscription);
    }

    @Override
    public void onNext(List<ByteBuffer> buffers) {
        if (failed) {
            return;
        }
        for (var buffer : buffers) {
            if (buffer.remaining() > MAX_BYTES - received) {
                failed = true;
                subscription.cancel();
                delegate.onError(new IOException("Policy response exceeds size limit"));
                return;
            }
            received += buffer.remaining();
        }
        delegate.onNext(buffers);
    }

    @Override
    public void onError(Throwable failure) {
        if (!failed) {
            failed = true;
            delegate.onError(failure);
        }
    }

    @Override
    public void onComplete() {
        if (!failed) {
            delegate.onComplete();
        }
    }
}
