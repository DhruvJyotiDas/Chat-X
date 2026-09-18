package main

import (
	"strings"
	"testing"
)

func TestShouldSearchWeb(t *testing.T) {
	tests := []struct {
		query string
		want  bool
	}{
		{"search the web for the latest LiveKit release", true},
		{"look this up on the internet", true},
		{"today's weather in Mumbai", true},
		{"current exchange rate from INR to USD", true},
		{"what are my current tasks?", false},
		{"what is on my calendar this week?", false},
		{"summarize my recent chats", false},
	}
	for _, test := range tests {
		if got := shouldSearchWeb(test.query); got != test.want {
			t.Errorf("shouldSearchWeb(%q)=%v, want %v", test.query, got, test.want)
		}
	}
}

func TestBoundedWebQuery(t *testing.T) {
	long := ""
	for i := 0; i < 100; i++ {
		long += "word "
	}
	got := boundedWebQuery(long)
	if len([]rune(got)) > 600 {
		t.Fatalf("query exceeds provider character limit: %d", len([]rune(got)))
	}
	if words := len(strings.Fields(got)); words > 75 {
		t.Fatalf("query exceeds provider word limit: %d", words)
	}
}
