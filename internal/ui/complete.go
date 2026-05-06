package ui

import (
	"os"
	"path/filepath"
	"strings"
)

// extractAtPartial returns the partial path after the last active @ (one not
// followed by a space), or ("", false) when there is no active mention.
func extractAtPartial(val string) (string, bool) {
	idx := strings.LastIndex(val, "@")
	if idx == -1 {
		return "", false
	}
	rest := val[idx+1:]
	if strings.ContainsRune(rest, ' ') {
		return "", false
	}
	return rest, true
}

// applyCompletion replaces the text after the last @ with selected.
func applyCompletion(val, selected string) string {
	idx := strings.LastIndex(val, "@")
	if idx == -1 {
		return val
	}
	return val[:idx+1] + selected
}

// getCompletions lists filesystem entries under cwd that match the partial path.
// Directories get a trailing slash so the user knows they can keep typing.
func getCompletions(partial, cwd string) []string {
	dir := cwd
	prefix := partial

	if idx := strings.LastIndex(partial, "/"); idx >= 0 {
		dir = filepath.Join(cwd, partial[:idx+1])
		prefix = partial[idx+1:]
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	low := strings.ToLower(prefix)
	var results []string
	for _, e := range entries {
		name := e.Name()
		// skip hidden entries unless the user explicitly typed a dot
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(prefix, ".") {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(name), low) {
			continue
		}
		rel, err := filepath.Rel(cwd, filepath.Join(dir, name))
		if err != nil {
			continue
		}
		if e.IsDir() {
			rel += "/"
		}
		results = append(results, rel)
	}
	return results
}
