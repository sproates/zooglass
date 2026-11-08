package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.*;

import io.zooglass.access.AccessGrant;
import io.zooglass.access.ViewResource;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.ServletOutputStream;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

class AuthorisedHttpWriterTests {

    private final AccessGrant grant = mock(AccessGrant.class);
    private final ViewResource resource = new ViewResource("orders", "42");
    private final AsyncContext context = mock(AsyncContext.class);
    private final ServletOutputStream output = mock(ServletOutputStream.class);
    private final MockHttpServletResponse response = new MockHttpServletResponse();
    private final Runnable abort = mock(Runnable.class);

    @Test
    void expiryWhileWaitingBeforeFirstChunkReturnsEmptyUnavailableResponse() throws Exception {
        var ready = new AtomicBoolean();
        var current = new AtomicBoolean(true);
        when(output.isReady()).thenAnswer(call -> ready.get());
        when(grant.permits(resource)).thenAnswer(call -> current.get());
        var writer = writer(new byte[20_000]);
        writer.onWritePossible();
        verify(grant, never()).permits(any());
        current.set(false);
        ready.set(true);
        writer.onWritePossible();
        assertThat(response.getStatus()).isEqualTo(503);
        assertThat(response.getContentLength()).isZero();
        verify(output, never()).write(any(byte[].class), anyInt(), anyInt());
        verify(context).complete();
        verifyNoInteractions(abort);
    }

    @Test
    void resumedWriterAbortsWithoutReleasingAnotherChunkAfterExpiry() throws Exception {
        when(output.isReady()).thenReturn(true, false, true);
        when(grant.permits(resource)).thenReturn(true, false);
        doAnswer(call -> { response.setCommitted(true); return null; })
                .when(output).write(any(byte[].class), anyInt(), anyInt());
        var writer = writer(new byte[20_000]);
        writer.onWritePossible();
        verify(context, never()).complete();
        writer.onWritePossible();
        verify(output, times(1)).write(any(byte[].class), eq(0), eq(8192));
        verify(abort).run();
        verify(context).complete();
        assertThat(response.getStatus()).isEqualTo(200);
        writer.onWritePossible();
        verify(output, times(1)).write(any(byte[].class), anyInt(), anyInt());
    }

    @Test
    void allowedBodyIsHandedOffExactlyOnceInBoundedChunks() throws Exception {
        when(output.isReady()).thenReturn(true);
        when(grant.permits(resource)).thenReturn(true);
        byte[] body = new byte[20_001];
        for (int i = 0; i < body.length; i++) body[i] = (byte) i;
        var received = new ByteArrayOutputStream();
        doAnswer(call -> {
            int length = call.getArgument(2);
            assertThat(length).isBetween(1, 8192);
            received.write(call.getArgument(0), call.getArgument(1), length);
            return null;
        }).when(output).write(any(byte[].class), anyInt(), anyInt());
        var writer = writer(body);
        writer.onWritePossible();
        writer.onWritePossible();
        assertThat(received.toByteArray()).isEqualTo(body);
        assertThat(response.getContentLength()).isEqualTo(body.length);
        verify(grant, times(3)).permits(resource);
        verify(context).complete();
        verifyNoInteractions(abort);
    }

    @Test
    void expiryAlsoHidesAnAuthorisedMissingResourceResult() throws Exception {
        when(output.isReady()).thenReturn(true);
        var writer = new AuthorisedHttpWriter(context, response, output, abort, grant, resource, 404, new byte[0]);
        writer.onWritePossible();
        assertThat(response.getStatus()).isEqualTo(503);
        verify(context).complete();
    }

    @Test
    void timeoutAbortsACommittedStallWithoutWaitingForReadiness() {
        response.setCommitted(true);
        var writer = writer(new byte[20_000]);
        writer.onTimeout(new AsyncEvent(context));
        writer.onTimeout(new AsyncEvent(context));
        verify(abort).run();
        verify(context).complete();
        verifyNoInteractions(output);
    }

    @Test
    void timeoutBeforeCommitReturnsUnavailableAndErrorAlwaysAborts() {
        writer(new byte[20_000]).onTimeout(new AsyncEvent(context));
        assertThat(response.getStatus()).isEqualTo(503);
        verifyNoInteractions(abort);
        var failing = writer(new byte[20_000]);
        failing.onError(new java.io.IOException("disconnected"));
        failing.onError(new java.io.IOException("disconnected again"));
        verify(abort).run();
        verify(context, times(2)).complete();
    }

    private AuthorisedHttpWriter writer(byte[] body) {
        return new AuthorisedHttpWriter(context, response, output, abort, grant, resource, 200, body);
    }
}
