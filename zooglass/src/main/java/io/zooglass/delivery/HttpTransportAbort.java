package io.zooglass.delivery;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;

import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.apache.coyote.ActionCode;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

import java.io.IOException;

/** Supplies a real stream abort: completing a servlet response alone can signal success. */
@Component
public final class HttpTransportAbort implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    private static final String ATTRIBUTE = HttpTransportAbort.class.getName();

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        factory.addContextValves(new ValveBase(true) {
            @Override
            public void invoke(Request request, Response response) throws IOException, ServletException {
                request.setAttribute(ATTRIBUTE, (Runnable) () -> response.getCoyoteResponse()
                        .action(ActionCode.CLOSE_NOW, new IOException("Protected response aborted")));
                getNext().invoke(request, response);
            }
        });
    }

    static Runnable forRequest(HttpServletRequest request) {
        if (request.getAttribute(ATTRIBUTE) instanceof Runnable abort) {
            return abort;
        }
        throw new IllegalStateException("Protected HTTP delivery requires a transport abort adapter");
    }
}
