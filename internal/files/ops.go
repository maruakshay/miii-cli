package files

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type FileRef struct {
	Path    string
	Content string
}

var atRe = regexp.MustCompile(`@([\w./\-]+)`)

func ResolveAtMentions(input, cwd string) []FileRef {
	matches := atRe.FindAllStringSubmatch(input, -1)
	var refs []FileRef
	seen := map[string]bool{}
	for _, m := range matches {
		p := m[1]
		if seen[p] {
			continue
		}
		seen[p] = true
		data, err := os.ReadFile(filepath.Join(cwd, p))
		if err == nil {
			refs = append(refs, FileRef{Path: p, Content: string(data)})
		}
	}
	return refs
}

type WriteBlock struct {
	Path    string
	Content string
}

type EditBlock struct {
	Path    string
	Search  string
	Replace string
}

type ParsedResponse struct {
	Text   string
	Writes []WriteBlock
	Edits  []EditBlock
}

var (
	writeRe = regexp.MustCompile(`(?s)<write_file path="([^"]+)">(.*?)</write_file>`)
	editRe  = regexp.MustCompile(`(?s)<edit_file path="([^"]+)">(.*?)</edit_file>`)
)

func ParseResponse(raw string) ParsedResponse {
	var writes []WriteBlock
	var edits []EditBlock
	text := raw

	for _, m := range writeRe.FindAllStringSubmatch(raw, -1) {
		content := strings.Trim(m[2], "\n")
		writes = append(writes, WriteBlock{Path: m[1], Content: content})
		text = strings.Replace(text, m[0], "[wrote: "+m[1]+"]", 1)
	}

	for _, m := range editRe.FindAllStringSubmatch(raw, -1) {
		inner := m[2]
		sep := strings.Index(inner, "=======")
		if sep == -1 {
			continue
		}
		search := strings.TrimRight(strings.TrimPrefix(inner[:sep], "<<<<<<< SEARCH\n"), "\n")
		replace := strings.TrimLeft(strings.TrimSuffix(inner[sep+7:], "\n>>>>>>> REPLACE"), "\n")
		edits = append(edits, EditBlock{Path: m[1], Search: search, Replace: replace})
		text = strings.Replace(text, m[0], "[edited: "+m[1]+"]", 1)
	}

	return ParsedResponse{Text: strings.TrimSpace(text), Writes: writes, Edits: edits}
}

func ApplyWrite(block WriteBlock, cwd string) error {
	abs := filepath.Join(cwd, block.Path)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, []byte(block.Content), 0o644)
}

func ApplyEdit(block EditBlock, cwd string) (bool, error) {
	abs := filepath.Join(cwd, block.Path)
	data, err := os.ReadFile(abs)
	if err != nil {
		return false, err
	}
	s := string(data)
	if !strings.Contains(s, block.Search) {
		return false, nil
	}
	return true, os.WriteFile(abs, []byte(strings.Replace(s, block.Search, block.Replace, 1)), 0o644)
}
