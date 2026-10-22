package io.zooglass;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/views")
public class ViewController {

    private final ViewStore viewStore;

    public ViewController(ViewStore viewStore) {
        this.viewStore = viewStore;
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
