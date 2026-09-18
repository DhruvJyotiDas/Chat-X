package main

import (
	"testing"
	"time"
)

func TestEventOccurrencesWeekdaysSkipsWeekend(t *testing.T) {
	start := time.Date(2026, 9, 18, 9, 0, 0, 0, time.UTC) // Friday
	end := start.Add(time.Hour)
	items := eventOccurrences(start, end, start, start.AddDate(0, 0, 5), "WEEKDAYS", 20)
	if len(items) != 3 {
		t.Fatalf("expected Friday, Monday and Tuesday, got %d occurrences", len(items))
	}
	if items[1][0].Weekday() != time.Monday || items[2][0].Weekday() != time.Tuesday {
		t.Fatalf("weekday recurrence did not skip weekend: %v, %v", items[1][0], items[2][0])
	}
}

func TestParseLocalDateTimePreservesUserTimezone(t *testing.T) {
	parsed, err := parseLocalDateTime("2026-09-16", "09:30", "Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.UTC().Format("15:04"); got != "04:00" {
		t.Fatalf("expected 09:30 IST to be 04:00 UTC, got %s", got)
	}
}

func TestNormalizeEventRejectsBackwardsTime(t *testing.T) {
	input := CalendarEventInput{Title: "Review", Date: "2026-09-16", StartTime: "11:00", EndTime: "10:00", TimeZone: "Asia/Kolkata"}
	if err := normalizeEventInput(&input); err == nil {
		t.Fatal("expected end-before-start validation error")
	}
}
