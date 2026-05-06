BIN := miii
INSTALL_DIR := /usr/local/bin

.PHONY: build install uninstall

build:
	go build -ldflags="-s -w" -o $(BIN) .

install: build
	cp $(BIN) $(INSTALL_DIR)/$(BIN)
	@echo "installed → $(INSTALL_DIR)/$(BIN)"

uninstall:
	rm -f $(INSTALL_DIR)/$(BIN)
	@echo "removed $(INSTALL_DIR)/$(BIN)"
