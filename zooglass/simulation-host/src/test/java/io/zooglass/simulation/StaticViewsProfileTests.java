package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.StaticViewsTestSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.StaticViewsTimelineProfile;
import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class StaticViewsProfileTests {
    @ParameterizedTest
    @ValueSource(strings = {"arrival", "latestBySequence", "historyBySequence"})
    void admitsEachStrategyWithOneOrTwoTypesAndTheMixedFamily(String mode) {
        var config = configuration();
        field(config, "arrival").put("mode", mode);
        admitted(config);
        aliases(field(config, "arrival"), "feed", "sample", "feed", "corrected");
        admitted(config);
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString())))
                .isEqualTo("unsupported");
    }

    @Test
    void admitsMaximumShapeAndBothExistingDeliveryPoliciesWithoutReclassifyingFleet() {
        var config = configuration();
        sources(config).add(JSON.readTree("{\"id\":\"aux\",\"epoch\":\"v1\"}"));
        sources(config).add(JSON.readTree("{\"id\":\"third\",\"epoch\":\"v1\"}"));
        views(config).add(JSON.readTree("""
                {"id":"other","fields":{"value":{"sourceId":"aux","type":"sample","mode":"arrival"}}}
                """));
        admitted(config);
        config.set("delivery", JSON.readTree("{\"slowClient\":\"coalesceLatestState\"}"));
        admitted(config);
        var fleet = TimelineRuntime.inspectConfiguration(FleetTestSupport.CONFIGURATION);
        assertThat(StaticViewsTimelineProfile.inspect(fleet)).isEmpty();
        assertThat(TimelineProfile.inspect(fleet)).isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
    }

    @ParameterizedTest
    @ValueSource(strings = {"maxStreams", "identityWindow", "maxHistoryEntries"})
    void admitsInclusiveResourceBoundsButProductionOwnsInvalidValues(String limit) {
        admitted(configuration().put(limit, 1));
        admitted(configuration().put(limit, 20));
        rejects(configuration().put(limit, 21), "$." + limit);
        assertThatThrownBy(() -> inspect(configuration().put(limit, 0)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void deliveryBoundsAreInclusive() {
        var config = configuration();
        config.set("delivery", JSON.readTree("{\"maxQueuedMessages\":2,\"maxQueuedBytes\":1}"));
        admitted(config);
        config.set("delivery", JSON.readTree("{\"maxQueuedMessages\":128,\"maxQueuedBytes\":1048576}"));
        admitted(config);
        ((ObjectNode) config.path("delivery")).put("maxQueuedMessages", 129);
        rejects(config, "$.delivery.maxQueuedMessages");
        ((ObjectNode) config.path("delivery")).put("maxQueuedMessages", 128).put("maxQueuedBytes", 1048577);
        rejects(config, "$.delivery.maxQueuedBytes");
    }

    @Test
    void reportsShapeLimitsWithoutRestrictingNamesToDemonstrations() {
        var config = configuration();
        for (int i = 0; i < 3; i++) sources(config).add(JSON.readTree("{\"id\":\"extra" + i + "\",\"epoch\":\"v1\"}"));
        rejects(config, "$.sources");
        config = configuration();
        for (int i = 0; i < 2; i++) views(config).add(((ObjectNode) views(config).get(0)).deepCopy().put("id", "other" + i));
        rejects(config, "$.views");
        config = configuration();
        ((ObjectNode) config.path("views").get(0).path("fields")).set("extra", field(config, "arrival").deepCopy());
        rejects(config, "$.views[0].fields");
        config = configuration();
        var second = ((ObjectNode) views(config).get(0)).deepCopy().put("id", "second");
        ((ObjectNode) second.path("fields")).remove("history");
        views(config).add(second);
        rejects(config, "$.views");
        config = configuration();
        config.set("views", JSON.createArrayNode());
        config.set("sources", JSON.createArrayNode());
        rejects(config, "$.sources");
        rejects(config, "$.views");
        config = configuration();
        var fields = (ObjectNode) config.path("views").get(0).path("fields");
        fields.set("quote\"and\nnewline", fields.remove("arrival"));
        admitted(config);
        ((ObjectNode) fields.path("quote\"and\nnewline")).set("freshness", JSON.readTree("{\"mode\":\"receiptAge\",\"staleAfterMillis\":5}"));
        rejects(config, "$.views[0].fields[\"quote\\\"and\\nnewline\"].freshness.mode");
    }

    @Test
    void rejectsProductionValidPoliciesOutsideTheFamily() {
        rejects(configuration().put("storage", "sqlite"), "$.storage");
        var config = configuration();
        field(config, "arrival").set("freshness", JSON.readTree("{\"mode\":\"receiptAge\",\"staleAfterMillis\":5}"));
        rejects(config, "$.views[0].fields[\"arrival\"].freshness.mode");
        config = configuration();
        ((ObjectNode) sources(config).get(0)).set("progress", JSON.readTree("""
                {"mode":"contiguousSequence","startSequence":1,"maxReceivedRanges":20,"maxMissingRanges":20}
                """));
        field(config, "arrival").set("late", JSON.readTree("{\"mode\":\"rejectBehindWatermark\"}"));
        rejects(config, "$.sources[0].progress.mode");
        rejects(config, "$.views[0].fields[\"arrival\"].late.mode");
        config = configuration();
        ((ObjectNode) views(config).get(0)).set("entities", JSON.readTree("""
                {"feed":{"mode":"lookupEntity","keys":{"one":"target"}}}
                """));
        rejects(config, "$.views[0].entities[\"feed\"].mode");
        config = configuration();
        ((ObjectNode) views(config).get(0)).set("publication", JSON.readTree("""
                {"mode":"requireContributions","fields":["arrival"],"maxPendingEntities":5}
                """));
        rejects(config, "$.views[0].publication.mode");
        config = configuration();
        sources(config).add(JSON.readTree("{\"id\":\"other\",\"epoch\":\"v1\"}"));
        aliases(field(config, "latest"), "feed", "sample", "other", "sample");
        field(config, "latest").set("conflict", JSON.readTree("{\"mode\":\"sourcePriority\",\"sources\":[\"feed\",\"other\"]}"));
        rejects(config, "$.views[0].fields[\"latest\"].inputs");
        rejects(config, "$.views[0].fields[\"latest\"].conflict");
        config = configuration();
        aliases(field(config, "arrival"), "feed", "sample", "feed", "corrected");
        ((ArrayNode) field(config, "arrival").path("inputs")).add(JSON.readTree("{\"sourceId\":\"feed\",\"type\":\"third\"}"));
        rejects(config, "$.views[0].fields[\"arrival\"].inputs");
        config = configuration();
        field(config, "arrival").put("mode", "sumActiveFacts").put("property", "amount")
                .set("facts", JSON.readTree("{\"revision\":\"firstFact\",\"maxRetainedFacts\":5,\"minimumBirthSequence\":1}"));
        rejects(config, "$.views[0].fields[\"arrival\"].mode");
        rejects(config, "$.views[0].fields[\"arrival\"].facts");
        rejects(config, "$.views[0].fields[\"arrival\"].property");
    }

    static void aliases(ObjectNode field, String source, String type, String otherSource, String otherType) {
        field.remove("sourceId");
        field.remove("type");
        field.set("inputs", JSON.createArrayNode()
                .add(JSON.createObjectNode().put("sourceId", source).put("type", type))
                .add(JSON.createObjectNode().put("sourceId", otherSource).put("type", otherType)));
    }

    private static ArrayNode sources(ObjectNode config) { return (ArrayNode) config.path("sources"); }
    private static ArrayNode views(ObjectNode config) { return (ArrayNode) config.path("views"); }
    private static java.util.List<StaticViewsTimelineProfile.Issue> inspect(ObjectNode config) {
        return StaticViewsTimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString()));
    }
    private static void admitted(ObjectNode config) { assertThat(inspect(config)).isEmpty(); }
    private static void rejects(ObjectNode config, String path) {
        assertThat(inspect(config)).extracting(StaticViewsTimelineProfile.Issue::path).contains(path);
    }
}
