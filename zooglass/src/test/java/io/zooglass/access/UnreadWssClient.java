package io.zooglass.access;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;

import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/** Real TLS/WebSocket peer that reads only upgrade headers, then stops reading entirely. */
final class UnreadWssClient implements AutoCloseable {
    private final SSLSocket socket;

    UnreadWssClient(SSLContext tls, int port) throws Exception {
        socket = (SSLSocket) tls.getSocketFactory().createSocket();
        try {
            socket.setReceiveBufferSize(1024);
            socket.setSoTimeout(5000);
            var parameters = socket.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            socket.setSSLParameters(parameters);
            socket.connect(new InetSocketAddress("localhost", port), 5000);
            socket.startHandshake();
            byte[] nonce = new byte[16];
            new SecureRandom().nextBytes(nonce);
            String key = Base64.getEncoder().encodeToString(nonce);
            String request = "GET /views/live HTTP/1.1\r\nHost: localhost:" + port
                    + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13"
                    + "\r\nSec-WebSocket-Key: " + key + "\r\nAuthorization: Bearer slow\r\n\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
            var headers = new ByteArrayOutputStream();
            while (!headers.toString(StandardCharsets.US_ASCII).endsWith("\r\n\r\n")) {
                int next = socket.getInputStream().read();
                if (next < 0 || headers.size() >= 16384) throw new AssertionError("Incomplete WebSocket upgrade");
                headers.write(next);
            }
            String response = headers.toString(StandardCharsets.US_ASCII);
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                    .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            if (!response.startsWith("HTTP/1.1 101 ") || !response.contains(accept)) {
                throw new AssertionError("WebSocket upgrade refused: " + response);
            }
        } catch (Exception | AssertionError failure) {
            socket.close();
            throw failure;
        }
    }

    void subscribe() throws Exception {
        byte[] text = "{\"action\":\"subscribe\",\"viewId\":\"positions\",\"entityId\":\"slow\"}"
                .getBytes(StandardCharsets.UTF_8);
        byte[] mask = new byte[4];
        new SecureRandom().nextBytes(mask);
        var output = socket.getOutputStream();
        output.write(0x81);
        output.write(0x80 | text.length);
        output.write(mask);
        for (int index = 0; index < text.length; index++) output.write(text[index] ^ mask[index % 4]);
        output.flush();
        // Deliberately no frame reads: TCP backpressure reaches the actual TLS transport.
    }

    @Override
    public void close() throws Exception {
        if (socket.isClosed()) return;
        socket.setSoLinger(true, 0);
        socket.close();
    }
}
