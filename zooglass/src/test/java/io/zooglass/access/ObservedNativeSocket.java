package io.zooglass.access;

import jakarta.websocket.RemoteEndpoint;
import jakarta.websocket.SendHandler;
import jakarta.websocket.Session;

import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.NativeWebSocketSession;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;

/** Transparent forwarding probes: every observed text write still uses the real native transport. */
final class ObservedNativeSocket {
    record Write(int characters, CompletableFuture<Void> submitted, CompletableFuture<Void> completed) {}

    final LinkedBlockingQueue<Write> writes = new LinkedBlockingQueue<>();
    final AtomicInteger submissions = new AtomicInteger();
    final CompletableFuture<Void> closed = new CompletableFuture<>();
    final WebSocketSession viewer;

    ObservedNativeSocket(WebSocketSession original) {
        var actual = ((NativeWebSocketSession) original).getNativeSession(Session.class);
        var remote = proxy(RemoteEndpoint.Async.class, (method, args) -> {
            if (method.getName().equals("sendText") && args.length == 2 && args[1] instanceof SendHandler handler) {
                var write = new Write(((String) args[0]).length(), new CompletableFuture<>(), new CompletableFuture<>());
                submissions.incrementAndGet();
                writes.add(write);
                args[1] = (SendHandler) result -> {
                    if (result.isOK()) write.completed.complete(null);
                    else write.completed.completeExceptionally(result.getException());
                    handler.onResult(result);
                };
                try {
                    Object result = invoke(method, actual.getAsyncRemote(), args);
                    write.submitted.complete(null);
                    return result;
                } catch (Throwable failure) {
                    write.submitted.completeExceptionally(failure);
                    throw failure;
                }
            }
            return invoke(method, actual.getAsyncRemote(), args);
        });
        var nativeSession = proxy(Session.class, (method, args) -> method.getName().equals("getAsyncRemote")
                ? remote : invoke(method, actual, args));
        viewer = proxy(NativeWebSocketSession.class, (method, args) -> method.getName().equals("getNativeSession")
                ? nativeSession : invoke(method, original, args));
    }

    private interface Forward {
        Object call(Method method, Object[] arguments) throws Throwable;
    }

    private static <T> T proxy(Class<T> type, Forward forward) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            if (method.getName().equals("equals")) return proxy == args[0];
            if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
            return forward.call(method, args);
        }));
    }

    private static Object invoke(Method method, Object target, Object[] arguments) throws Throwable {
        try {
            return method.invoke(target, arguments);
        } catch (InvocationTargetException failed) {
            throw failed.getCause();
        }
    }
}
