package io.zooglass.runtime;

import java.util.List;

/** The static-field family with explicit generation replacement and durable recovery. */
public final class StaticRecoveryTimelineProfile {
    public static final String NAME = "static-views-restart-v1";

    private StaticRecoveryTimelineProfile() {}

    public static List<StaticViewsTimelineProfile.Issue> inspect(RuntimeConfiguration config) {
        return StaticViewsTimelineProfile.inspect(config, true);
    }
}
