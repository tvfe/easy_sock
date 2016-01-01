TESTS = $(shell ls -S `find test -type f -name "*.test.js" -print`)


all: test

test:
	./node_modules/.bin/mocha -r should $(TESTS)

benchmark bench:
	./node_modules/.bin/matcha benchmark/*.js


.PHONY: all test benchmark bench