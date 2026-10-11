package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

func TestRealClusterPreservesBinaryKeys(t *testing.T) {
	port := os.Getenv("GROVE_TEST_PORT")
	if port == "" {
		t.Skip("set GROVE_TEST_PORT for the dedicated local cluster")
	}
	key := "\xffgrove:integration"
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("valkey-cli", append([]string{"-c", "-p", port}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("valkey-cli: %v", err)
		}
		return strings.TrimSpace(string(out))
	}
	if run("SET", key, "test") != "OK" {
		t.Fatal("test key setup failed")
	}
	defer run("DEL", key)
	expected, err := strconv.Atoi(run("CLUSTER", "KEYSLOT", key))
	if err != nil {
		t.Fatal(err)
	}
	c := &Collector{Address: "127.0.0.1:" + port, Limit: 24000}
	s, err := c.collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Keys []map[string]any `json:"keys"`
	}
	if err = json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	for _, k := range result.Keys {
		if k["name"] == base64.StdEncoding.EncodeToString([]byte(key)) {
			if k["encoding"] != "base64" || k["slot"] != float64(expected) {
				t.Fatalf("binary key identity corrupted: %v", k)
			}
			return
		}
	}
	t.Fatal("binary key was not preserved in the snapshot")
}

func TestLocalHTTPBoundaryAndConnectionFailure(t *testing.T) {
	h := handler(&Collector{Address: "127.0.0.1:1", Limit: 1})
	for _, tc := range []struct {
		host, origin string
		status       int
	}{{"attacker.example", "", 403}, {"127.0.0.1:4187", "https://attacker.example", 403}, {"127.0.0.1:4187", "", 502}} {
		r := httptest.NewRequest("GET", "http://"+tc.host+"/api/snapshot", nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("host %s: got %d, want %d", tc.host, w.Code, tc.status)
		}
	}
}
