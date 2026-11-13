package io.zooglass.simulation;

import static org.assertj.core.api.Assertions.*;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicReference;

class TurnContextTests {
    @Test
    void clockAndCallbacksRequireAnOwnedTurn() throws Exception {
        var turns = new TurnContext();
        assertThatThrownBy(turns::now).isInstanceOf(IllegalStateException.class);
        turns.begin(0);
        var failure = new AtomicReference<Throwable>();
        var worker =
                new Thread(
                        () -> {
                            try {
                                turns.now();
                            } catch (Throwable error) {
                                failure.set(error);
                            }
                        });
        worker.start();
        worker.join();
        assertThat(failure.get()).isInstanceOf(IllegalStateException.class);
        long task = turns.schedule(5, 1, () -> turns.effect(java.util.Map.of("kind", "ran")));
        assertThat(turns.end()).hasSize(1);
        assertThatThrownBy(() -> turns.dispatch(task)).isInstanceOf(IllegalStateException.class);
        turns.begin(5);
        turns.dispatch(task);
        assertThat(turns.end()).containsExactly(java.util.Map.of("kind", "ran"));
        assertThatThrownBy(() -> turns.begin(4)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void cancellationAndDuplicateTaskDispatchAreExplicit() {
        var turns = new TurnContext();
        turns.begin(0);
        long task =
                turns.schedule(
                        0,
                        2,
                        () -> {
                            throw new AssertionError("cancelled callback ran");
                        });
        turns.cancel(task);
        assertThat(turns.pendingCount()).isZero();
        assertThatThrownBy(() -> turns.dispatch(task)).isInstanceOf(IllegalStateException.class);
        assertThat(turns.end())
                .extracting(effect -> effect.get("kind"))
                .containsExactly("schedule", "cancel");
    }

    @Test
    void keyedDrawMatchesPublishedNodeVector() throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        for (String part :
                new String[] {
                    "zooglass-timeline-draw-v1",
                    "0".repeat(64),
                    "receipt",
                    "receipt-loss",
                    "source",
                    "publication-1",
                    "1",
                    "receipt",
                    "1",
                    "loss",
                    "0"
                }) {
            byte[] bytes = part.getBytes(StandardCharsets.UTF_8);
            digest.update(ByteBuffer.allocate(4).putInt(bytes.length).array());
            digest.update(bytes);
        }
        assertThat(HexFormat.of().formatHex(digest.digest()))
                .isEqualTo("3416900fd8e30db191adb87ebe56c575ab8e469c971e7cef355ce96462e974a5");
    }
}
