.PHONY: dev build install clean

dev:
	tsx src/index.ts

build:
	tsc

install: build
	npm link

clean:
	rm -rf dist
