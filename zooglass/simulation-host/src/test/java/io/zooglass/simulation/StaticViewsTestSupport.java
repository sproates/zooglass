package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;

import io.zooglass.runtime.StaticViewsTimelineProfile;

import tools.jackson.databind.node.ObjectNode;

final class StaticViewsTestSupport {
    private StaticViewsTestSupport() {}

    static ObjectNode configuration() {
        return (ObjectNode) JSON.readTree("""
                {"contractVersion":2,"storage":"memory","maxStreams":20,"identityWindow":20,
                 "maxHistoryEntries":20,"sources":[{"id":"feed","epoch":"v1"}],"views":[
                   {"id":"readings","fields":{
                     "arrival":{"sourceId":"feed","type":"sample","mode":"arrival"},
                     "latest":{"sourceId":"feed","type":"sample","mode":"latestBySequence"},
                     "history":{"sourceId":"feed","type":"sample","mode":"historyBySequence"}}}]}
                """);
    }

    static ObjectNode field(ObjectNode config, String name) {
        return (ObjectNode) config.path("views").get(0).path("fields").path(name);
    }

    static ObjectNode inspection(ObjectNode config) {
        return FleetTestSupport.turn("inspect-requested-profile", 0)
                .put("profile", StaticViewsTimelineProfile.NAME).put("wire", config.toString());
    }

    static ObjectNode initialization(ObjectNode config) {
        return FleetTestSupport.initialization().put("profile", StaticViewsTimelineProfile.NAME)
                .put("wire", config.toString());
    }
}
