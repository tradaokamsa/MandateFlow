package main

import (
	"testing"
	"time"
)

func TestValidControlToken(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{
			name:  "valid token",
			value: "mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			valid: true,
		},
		{name: "missing prefix", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", valid: false},
		{name: "wrong length", value: "mfc1_aaaaaaaa", valid: false},
		{name: "invalid encoding", value: "mfc1_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", valid: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validControlToken(test.value); got != test.valid {
				t.Fatalf("validControlToken(%q) = %v, want %v", test.value, got, test.valid)
			}
		})
	}
}

func TestEnvOr(t *testing.T) {
	t.Setenv("MANDATEFLOW_TEST_VALUE", "  configured  ")
	if got := envOr("MANDATEFLOW_TEST_VALUE", "fallback"); got != "configured" {
		t.Fatalf("envOr configured value = %q, want %q", got, "configured")
	}

	t.Setenv("MANDATEFLOW_TEST_VALUE", "   ")
	if got := envOr("MANDATEFLOW_TEST_VALUE", "fallback"); got != "fallback" {
		t.Fatalf("envOr blank value = %q, want %q", got, "fallback")
	}
}

func TestDurationFromMilliseconds(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		fallback int64
		want     time.Duration
	}{
		{name: "default", raw: "", fallback: 660_000, want: 660 * time.Second},
		{name: "valid", raw: "2500", fallback: 660_000, want: 2500 * time.Millisecond},
		{name: "invalid", raw: "not-a-number", fallback: 660_000, want: 660 * time.Second},
		{name: "too short", raw: "999", fallback: 660_000, want: 660 * time.Second},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("MANDATEFLOW_TEST_TTL", test.raw)
			if got := durationFromMilliseconds("MANDATEFLOW_TEST_TTL", test.fallback); got != test.want {
				t.Fatalf("durationFromMilliseconds(%q) = %s, want %s", test.raw, got, test.want)
			}
		})
	}
}
