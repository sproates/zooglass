package io.zooglass;

import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/views")
public class ViewController {

    private final ViewStore viewStore;

    public ViewController(ViewStore viewStore) {
        this.viewStore = viewStore;
    }

    @PostMapping
    public ResponseEntity<Void> defineView(@RequestBody ViewConfiguration.ViewDefinition definition) {
        try {
            if (!viewStore.define(definition)) {
                return ResponseEntity.status(HttpStatus.CONFLICT).build();
            }
            return ResponseEntity.status(HttpStatus.CREATED).build();
        } catch (IllegalArgumentException exception) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/{viewId}/{entityId}")
    public ResponseEntity<ViewSnapshot> getView(
            @PathVariable String viewId,
            @PathVariable String entityId) {
        return viewStore.get(viewId, entityId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
