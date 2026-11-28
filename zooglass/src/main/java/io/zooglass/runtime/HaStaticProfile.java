package io.zooglass.runtime;

import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.util.Comparator;
import java.util.Set;

/** Internal static deployment binding. Public serving requires the later ownership protocol. */
record HaStaticProfile(String runtimeId, String tenant, RuntimeConfiguration configuration) {
    static final String NAME = "ha-static-v1";
    private static final Set<String> FIELDS = Set.of("arrival", "latestBySequence", "historyBySequence");
    private static final JsonMapper IDENTITY = StateRowJson.JSON.rebuild()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();

    HaStaticProfile {
        if (runtimeId == null || runtimeId.isBlank() || !runtimeId.equals(runtimeId.strip())) {
            throw new IllegalArgumentException("A runtime identity is required");
        }
        StoredJson.requireUnicode(runtimeId);
        if (tenant != null) {
            StoreTenant.requireTenant(tenant);
            StoredJson.requireUnicode(tenant);
        }
        ConfigurationValidation.validatePostgres(configuration);
        if (configuration.sources().size() > 3 || configuration.views().size() > 2
                || configuration.views().stream().mapToInt(view -> view.fields().size()).sum() > 4) {
            throw new IllegalArgumentException("Static HA configuration exceeds its source, view or field bounds");
        }
        for (var source : configuration.sources()) {
            if (!"untracked".equals(source.progress().mode())) {
                throw new IllegalArgumentException("Static HA requires untracked progress");
            }
        }
        for (var view : configuration.views()) {
            if (view.fields().size() > 3 || view.entities().values().stream()
                    .anyMatch(entity -> !"envelopeEntity".equals(entity.mode()))) {
                throw new IllegalArgumentException("Static HA requires envelope mappings and at most three fields per view");
            }
            for (var field : view.fields().values()) {
                if (!FIELDS.contains(field.mode()) || !"unspecified".equals(field.freshness().mode())
                        || !"acceptLate".equals(field.late().mode())) {
                    throw new IllegalArgumentException("Unsupported static HA field configuration");
                }
            }
        }
        // Use the same canonical order for reconciliation and identity, including retained target outcomes.
        configuration = new RuntimeConfiguration(configuration.contractVersion(), configuration.storage(),
                configuration.maxStreams(), configuration.identityWindow(), configuration.maxHistoryEntries(),
                configuration.sources().stream().sorted(Comparator.comparing(RuntimeConfiguration.Source::id)).toList(),
                configuration.views().stream().sorted(Comparator.comparing(RuntimeConfiguration.View::id)).toList(),
                configuration.delivery());
    }

    String configurationIdentity() {
        return IDENTITY.writeValueAsString(configuration);
    }
}
