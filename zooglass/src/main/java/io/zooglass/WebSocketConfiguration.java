package io.zooglass;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfiguration implements WebSocketConfigurer {

    private final EventLoggingWebSocketHandler eventLoggingWebSocketHandler;
    private final LiveViewWebSocketHandler liveViewWebSocketHandler;

    public WebSocketConfiguration(
            EventLoggingWebSocketHandler eventLoggingWebSocketHandler,
            LiveViewWebSocketHandler liveViewWebSocketHandler) {
        this.eventLoggingWebSocketHandler = eventLoggingWebSocketHandler;
        this.liveViewWebSocketHandler = liveViewWebSocketHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(eventLoggingWebSocketHandler, "/events");
        registry.addHandler(liveViewWebSocketHandler, "/views/live");
    }
}
