package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.util.function.Consumer;

/** Owns execution and transport effects; queue policy and writer state remain shared. */
interface DeliveryDriver extends AutoCloseable {
    Writer writer(WebSocketSession session, ActiveViewGrants grants);

    /** Defer the action; never invoke it inline. */
    void execute(Runnable action);

    void closeSession(WebSocketSession session, CloseStatus status);

    @Override
    void close();

    interface Writer {
        /** Defer one bounded writer turn; never invoke it inline. */
        void execute(Runnable turn);

        /** Complete once, immediately or later, with null on success. */
        void send(OutboundQueue.Frame frame, Consumer<Exception> completed);

        /** Invalidate queued turns and interrupt native work without waiting for completion. */
        void stop();
    }
}
