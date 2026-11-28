package io.zooglass.delivery;

import io.zooglass.logging.ViewerLog;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

/** A locally allocated reference lives only on its owning socket. */
final class ViewerConnections {
    private static final String KEY = ViewerConnections.class.getName();

    private ViewerConnections() {}

    static void opened(ViewerLog log, WebSocketSession session) {
        var reference = log.newConnection();
        if (reference == null) return;
        try {
            if (session.getAttributes().putIfAbsent(KEY, reference) == null) {
                log.socket(ViewerLog.Event.OPEN, reference);
            }
        } catch (RuntimeException ignored) {
            // Diagnostic context is optional.
        }
    }

    static ViewerLog.ConnectionRef reference(ViewerLog log, WebSocketSession session) {
        if (log == ViewerLog.NONE) return null;
        try {
            return session.getAttributes().get(KEY) instanceof ViewerLog.ConnectionRef ref ? ref : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    static void closed(ViewerLog log, WebSocketSession session, CloseStatus status) {
        if (log == ViewerLog.NONE) return;
        try {
            if (session.getAttributes().remove(KEY) instanceof ViewerLog.ConnectionRef ref) {
                log.socket(status.getCode() == 1000 ? ViewerLog.Event.NORMAL_CLOSE : ViewerLog.Event.OTHER_CLOSE, ref);
            }
        } catch (RuntimeException ignored) {
            // Session cleanup has already run.
        }
    }
}
