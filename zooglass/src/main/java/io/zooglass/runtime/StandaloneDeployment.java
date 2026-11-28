package io.zooglass.runtime;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import java.lang.annotation.*;

@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@ConditionalOnProperty(name = "zooglass.deployment.profile", havingValue = "standalone", matchIfMissing = true)
public @interface StandaloneDeployment {}
