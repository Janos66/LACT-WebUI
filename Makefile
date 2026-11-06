export CARGO_TARGET_DIR ?= ./target
export CARGO_NET_GIT_FETCH_WITH_CLI ?= true
DESTDIR ?= /
PREFIX ?= /usr/local

.PHONY: build-release
build-release:
	cargo build -p lact --release

.PHONY: build-debug
build-debug:
	cargo build -p lact

.PHONY: build-webui
build-webui:
	cargo build -p lact-webui --release

.PHONY: build-release-headless
build-release-headless:
	cargo build -p lact --release --no-default-features --features=nvidia

.PHONY: test
test:
	cargo test -p lact-webui

.PHONY: install-resources
install-resources:
	install -Dm644 res/lactd.service $(DESTDIR)$(PREFIX)/lib/systemd/system/lactd.service
	install -Dm644 res/lact-webui.service $(DESTDIR)$(PREFIX)/lib/systemd/system/lact-webui.service
	install -Dm644 res/io.github.ilya_zlobintsev.LACT.policy $(DESTDIR)$(PREFIX)/share/polkit-1/actions/io.github.ilya_zlobintsev.LACT.policy
	install -Dm644 res/io.github.ilya_zlobintsev.LACT.svg $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/io.github.ilya_zlobintsev.LACT.svg

.PHONY: install
install: install-resources
	install -Dm755 target/release/lact $(DESTDIR)$(PREFIX)/bin/lact
	install -Dm755 target/release/lact-webui $(DESTDIR)$(PREFIX)/bin/lact-webui

.PHONY: install-debug
install-debug: install-resources
	install -Dm755 target/debug/lact $(DESTDIR)$(PREFIX)/bin/lact
	install -Dm755 target/debug/lact-webui $(DESTDIR)$(PREFIX)/bin/lact-webui

.PHONY: uninstall
uninstall:
	rm -f $(DESTDIR)$(PREFIX)/bin/lact
	rm -f $(DESTDIR)$(PREFIX)/bin/lact-webui
	rm -f $(DESTDIR)$(PREFIX)/lib/systemd/system/lactd.service
	rm -f $(DESTDIR)$(PREFIX)/lib/systemd/system/lact-webui.service
	rm -f $(DESTDIR)$(PREFIX)/share/polkit-1/actions/io.github.ilya_zlobintsev.LACT.policy
	rm -f $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/io.github.ilya_zlobintsev.LACT.svg

.PHONY: hash-password
hash-password:
	cargo run -q -p lact-webui -- --hash-password "$(PASSWORD)"

.PHONY: update-vulkan-schema
update-vulkan-schema:
	curl -o lact-daemon/vulkan_schema.json https://schema.khronos.org/vulkan/profiles-0.8-latest.json

.PHONY: update-nvidia-headers
update-nvidia-headers:
	cd lact-daemon/include/nvidia && ./update_kernel_files.sh
