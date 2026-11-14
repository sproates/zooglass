package io.zooglass.simulation;

import static io.zooglass.simulation.FleetTestSupport.*;
import static io.zooglass.simulation.HostProtocol.JSON;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class FleetProfileTests {
    @Test
    void admitsTheBoundedFleetAndSingleSequenceFieldsWithoutChangingReceiptAgeProfiles() {
        assertThat(profile(configuration())).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        var single = configuration();
        ((ArrayNode) single.path("views")).remove(1);
        fields(single).remove("operation");
        ((ArrayNode) single.path("sources")).remove(1);
        assertThat(profile(single)).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        position(single).put("mode", "historyBySequence");
        assertThat(profile(single)).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        position(single).put("mode", "arrival").set("freshness", JSON.readTree(
                "{\"mode\":\"receiptAge\",\"staleAfterMillis\":50}"));
        assertThat(profile(single)).isEqualTo(TimelineProfile.NAME);
        single.put("storage", "sqlite");
        assertThat(profile(single)).isEqualTo(TimelineProfile.SQLITE_RESTART);
    }

    @ParameterizedTest
    @ValueSource(strings = {"maxStreams", "identityWindow", "maxHistoryEntries"})
    void resourceBoundsAreInclusiveAndProductionRejectsNonpositiveValues(String limit) {
        assertThat(profile(configuration().put(limit, 1))).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        assertThat(profile(configuration().put(limit, 20))).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        assertThat(profile(configuration().put(limit, 21))).isEqualTo("unsupported");
        assertThatThrownBy(() -> profile(configuration().put(limit, 0)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsWiderSourcesViewsAndFieldCounts() {
        var thirdSource = configuration();
        ((ArrayNode) thirdSource.path("sources")).add(JSON.readTree("{\"id\":\"extra\",\"epoch\":\"v1\"}"));
        unsupported(thirdSource);
        var thirdView = configuration();
        ((ArrayNode) thirdView.path("views")).add(((ObjectNode) thirdView.path("views").get(1)).deepCopy()
                .put("id", "third"));
        unsupported(thirdView);
        var thirdField = configuration();
        fields(thirdField).set("extra", position(thirdField).deepCopy());
        ((ArrayNode) thirdField.path("views")).remove(1);
        unsupported(thirdField);
        var fourFields = configuration();
        ((ObjectNode) fourFields.path("views").get(1).path("fields"))
                .set("extra", position(fourFields).deepCopy());
        unsupported(fourFields);
        var empty = configuration();
        empty.set("views", JSON.createArrayNode());
        unsupported(empty);
    }

    @Test
    void rejectsStoragePoliciesAndMultiInputFieldsOutsideQualification() {
        unsupported(configuration().put("storage", "sqlite"));
        var arrival = configuration();
        position(arrival).put("mode", "arrival");
        unsupported(arrival);
        var age = configuration();
        position(age).set("freshness", JSON.readTree("{\"mode\":\"receiptAge\",\"staleAfterMillis\":50}"));
        unsupported(age);
        var progress = configuration();
        ((ObjectNode) progress.path("sources").get(0)).set("progress", JSON.readTree("""
                {"mode":"contiguousSequence","startSequence":1,"maxReceivedRanges":20,"maxMissingRanges":20}
                """));
        unsupported(progress);
        position(progress).set("late", JSON.readTree("{\"mode\":\"rejectBehindWatermark\"}"));
        unsupported(progress);
        var mapping = configuration();
        ((ObjectNode) mapping.path("views").get(1)).set("entities", JSON.readTree("""
                {"position":{"mode":"lookupEntity","keys":{"bus":"bus"}}}
                """));
        unsupported(mapping);
        var publication = configuration();
        ((ObjectNode) publication.path("views").get(0)).set("publication", JSON.readTree("""
                {"mode":"requireContributions","fields":["position"],"maxPendingEntities":20}
                """));
        unsupported(publication);
        var inputs = configuration();
        position(inputs).remove("sourceId");
        position(inputs).remove("type");
        position(inputs).set("inputs", JSON.readTree("""
                [{"sourceId":"position","type":"position"},{"sourceId":"position","type":"other"}]
                """));
        unsupported(inputs);
        var conflict = configuration();
        position(conflict).set("conflict", JSON.readTree("{\"mode\":\"sourcePriority\",\"sources\":[\"position\"]}"));
        unsupported(conflict);
        var facts = configuration();
        position(facts).put("mode", "activeFacts").set("facts", JSON.readTree("""
                {"revision":"latestFactRevision","maxRetainedFacts":20,"minimumBirthSequence":1}
                """));
        unsupported(facts);
        position(facts).put("mode", "sumActiveFacts").put("property", "amount");
        unsupported(facts);
        var delivery = configuration();
        delivery.set("delivery", JSON.readTree("{\"maxQueuedMessages\":129}"));
        unsupported(delivery);
        delivery.set("delivery", JSON.readTree("{\"maxQueuedBytes\":1048577}"));
        unsupported(delivery);
    }

    @Test
    void inspectionReportsTheProfileAndInitializationRequiresAnExplicitAgreement() throws Exception {
        var inspection = turn("inspect-configuration", 0).put("wire", CONFIGURATION);
        var report = JSON.valueToTree(new TimelineHost(HostProtocol.V1, false).command(inspection));
        assertThat(report.path("configuration").path("documentProfile").asString())
                .isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        var absent = initialization();
        absent.remove("profile");
        rejects(HostProtocol.V2, absent, "agreement");
        rejects(HostProtocol.V2, initialization().put("profile", TimelineProfile.NAME), "agreement");
        var v1 = initialization();
        v1.remove("profile");
        v1.remove("startTimeMs");
        rejects(HostProtocol.V1, v1, "Unsupported document configuration profile");
        rejects(HostProtocol.V2, initialization().put("runtimeGeneration", 2), "generation 1");
        rejects(HostProtocol.V2, initialization().put("startTimeMs", 1).put("timeMs", 1)
                .put("wallMillis", EPOCH + 1), "origin");
        rejects(HostProtocol.V2, initialization().put("wallOffsetMillis", 1), "origin");
        rejects(HostProtocol.V2, initialization().put("database", "/tmp/fleet.db"), "database path");
    }

    @Test
    void clockAndLifecycleRejectionsLeaveTheRunningFleetClockAlone() throws Exception {
        try (var fixture = new FleetTestSupport()) {
            fixture.start(configuration());
            for (String op : new String[] {"wall-clock-set", "service-stop", "service-start"})
                assertThatThrownBy(() -> fixture.host.command(turn(op, 1).put("wallMillis", EPOCH - 1)))
                        .isInstanceOf(IllegalArgumentException.class);
            var observed = fixture.call(turn("observe", 0));
            assertThat(observed.path("wallMillis").longValue()).isEqualTo(EPOCH);
        }
    }

    private static void rejects(HostProtocol protocol, ObjectNode command, String message) {
        assertThatThrownBy(() -> new TimelineHost(protocol, true).command(command))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining(message);
    }

    private static String profile(ObjectNode config) {
        return TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString()));
    }

    private static void unsupported(ObjectNode config) { assertThat(profile(config)).isEqualTo("unsupported"); }
    private static ObjectNode fields(ObjectNode config) { return (ObjectNode) config.path("views").get(0).path("fields"); }
    private static ObjectNode position(ObjectNode config) { return (ObjectNode) fields(config).path("position"); }
}
