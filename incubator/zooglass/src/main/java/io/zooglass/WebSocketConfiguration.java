package io.zooglass;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfiguration implements WebSocketConfigurer {

    private final EventLoggingWebSocketHandler eventLoggingWebSocketHandler;

    public WebSocketConfiguration(EventLoggingWebSocketHandler eventLoggingWebSocketHandler) {
        this.eventLoggingWebSocketHandler = eventLoggingWebSocketHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(eventLoggingWebSocketHandler, "/events");
    }
}
