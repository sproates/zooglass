package io.zooglass.access;

/** Explicit selection for admission handlers; no plugins or dynamic strategy loading. */
public final class AccessStrategySelection {

    public enum Mode { OPEN_DEMO, APPLICATION_POLICY }

    private AccessStrategySelection() {}

    public static ViewerAccess select(Mode mode, PolicySettings settings) {
        if (mode == null) {
            throw new IllegalArgumentException("Access mode is required");
        }
        return switch (mode) {
            case OPEN_DEMO -> {
                if (settings != null) {
                    throw new IllegalArgumentException("Open demo access cannot have policy settings");
                }
                yield new OpenDemoAccess();
            }
            case APPLICATION_POLICY -> {
                if (settings == null) {
                    throw new IllegalArgumentException("Application policy settings are required");
                }
                yield new ApplicationPolicyAccess(settings.tenant(),
                        new HttpsPolicyClient(settings), System::nanoTime);
            }
        };
    }
}
