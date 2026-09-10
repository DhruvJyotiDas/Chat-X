package main

import "testing"

func TestExtractJSONObjectHandlesBracesInStrings(t *testing.T) {
	input := `prefix {"summary":"Use {braces} safely","path":"c:\\tmp\\\"x"} suffix`
	got, ok := extractJSONObject(input)
	if !ok {
		t.Fatal("expected a JSON object")
	}
	want := `{"summary":"Use {braces} safely","path":"c:\\tmp\\\"x"}`
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestExtractJSONObjectRejectsIncompleteObject(t *testing.T) {
	if _, ok := extractJSONObject(`thinking {"summary":"unfinished"`); ok {
		t.Fatal("expected incomplete object to be rejected")
	}
}
