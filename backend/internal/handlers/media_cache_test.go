package handlers

import "testing"

func TestMediaIfNoneMatch(t *testing.T) {
	for _, tc := range []struct {
		name, value, etag string
		want              bool
	}{
		{"strong", `"current"`, `"current"`, true},
		{"weak-client", `W/"current"`, `"current"`, true},
		{"weak-server", `"current"`, `W/"current"`, true},
		{"weak-both", `W/"current"`, `W/"current"`, true},
		{"list", `"old", W/"current", "other"`, `"current"`, true},
		{"quoted-comma", `"old", W/"a,b"`, `"a,b"`, true},
		{"quoted-comma-is-not-separator", `"a,b"`, `"b"`, false},
		{"backslash-is-literal", `W/"a\b"`, `"a\b"`, true},
		{"empty-tag", `W/""`, `""`, true},
		{"empty-members", " ,\t, W/\"current\" , , ", `"current"`, true},
		{"wildcard", " \t* \t", `"current"`, true},
		{"empty-value", "", `"current"`, false},
		{"only-empty-members", " , , ", `"current"`, false},
		{"no-match", `W/"old", "other"`, `"current"`, false},
		{"unquoted", "current", `"current"`, false},
		{"wrong-case", `w/"current"`, `"current"`, false},
		{"incomplete-weak", "W/", `"current"`, false},
		{"unterminated", `"current`, `"current"`, false},
		{"missing-separator", `"old" "current"`, `"current"`, false},
		{"trailing-junk", `"current"junk`, `"current"`, false},
		{"invalid-member-after-match", `"current", invalid`, `"current"`, false},
		{"invalid-member-before-match", `invalid, "current"`, `"current"`, false},
		{"wildcard-list", `*, "current"`, `"current"`, false},
		{"wildcard-after-match", `"current", *`, `"current"`, false},
		{"space-in-tag", `"bad tag", "current"`, `"current"`, false},
		{"control-in-tag", "\"bad\x7ftag\", \"current\"", `"current"`, false},
		{"obs-text", "W/\"\x80\xff\"", "\"\x80\xff\"", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mediaIfNoneMatch(tc.value, tc.etag); got != tc.want {
				t.Errorf("If-None-Match=%q ETag=%q matched=%v want=%v", tc.value, tc.etag, got, tc.want)
			}
		})
	}
}
