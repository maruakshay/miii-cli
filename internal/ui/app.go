package ui

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"miii/internal/files"
	"miii/internal/llm"
)

// ── screens ───────────────────────────────────────────────────────────────────

type screen int

const (
	screenProviderPick screen = iota
	screenURLInput
	screenFetchModels
	screenModelPick
	screenChat
	screenFileBrowser
)

// ── async messages ────────────────────────────────────────────────────────────

type modelsMsg struct {
	models []string
	err    error
}

type chatMsg struct {
	content string
	err     error
}

// ── file browser entry ────────────────────────────────────────────────────────

type fbEntry struct {
	name  string
	isDir bool
}

func loadFBItems(dir string) []fbEntry {
	entries, _ := os.ReadDir(dir)
	var dirs, fls []fbEntry
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		item := fbEntry{name: e.Name(), isDir: e.IsDir()}
		if e.IsDir() {
			dirs = append(dirs, item)
		} else {
			fls = append(fls, item)
		}
	}
	return append(dirs, fls...)
}

// ── styles ────────────────────────────────────────────────────────────────────

var (
	cCyan   = lipgloss.Color("14")
	cGreen  = lipgloss.Color("10")
	cGray   = lipgloss.Color("8")
	cYellow = lipgloss.Color("11")
	cRed    = lipgloss.Color("9")
	cWhite  = lipgloss.Color("15")
	cDark   = lipgloss.Color("235")

	sBrand   = lipgloss.NewStyle().Foreground(cCyan).Bold(true)
	sTagline = lipgloss.NewStyle().Foreground(cGray)
	sDim     = lipgloss.NewStyle().Foreground(cGray)
	sHint    = lipgloss.NewStyle().Foreground(cGray).Faint(true)
	sSel     = lipgloss.NewStyle().Foreground(cCyan).Bold(true)
	sUser    = lipgloss.NewStyle().Foreground(cCyan).Bold(true)
	sAssist  = lipgloss.NewStyle().Foreground(cGreen).Bold(true)
	sOk      = lipgloss.NewStyle().Foreground(cGreen)
	sErr     = lipgloss.NewStyle().Foreground(cRed)
	sDir     = lipgloss.NewStyle().Foreground(cCyan)
	sFile    = lipgloss.NewStyle().Foreground(cWhite)

	sCompSel = lipgloss.NewStyle().
			Foreground(lipgloss.Color("0")).
			Background(cCyan)

	sBtn = lipgloss.NewStyle().
		Foreground(cGray).
		Background(cDark).
		Padding(0, 1)

	sBtnActive = lipgloss.NewStyle().
			Foreground(cCyan).
			Background(cDark).
			Padding(0, 1).
			Bold(true)

	sInputBorder = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(cCyan).
			PaddingLeft(1)

	sSetupBox = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(cGray).
			Padding(1, 3)

	sFBBox = lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(cCyan).
		Padding(1, 2)
)

// ── model ─────────────────────────────────────────────────────────────────────

type Model struct {
	screen        screen
	prevScreen    screen
	cwd           string
	width         int
	height        int
	providerIdx   int
	urlInput      textinput.Model
	fetchErr      string
	provider      llm.Provider
	models        []string
	modelIdx      int
	selectedModel string
	messages      []llm.Message
	chatInput     textinput.Model
	sp            spinner.Model
	thinking      bool
	vp            viewport.Model
	vpReady       bool
	completions   []string
	compIdx       int
	// file browser
	fbDir    string
	fbItems  []fbEntry
	fbCursor int
}

const systemPrompt = `You are a fast coding assistant with file editing capabilities.

To create or fully overwrite a file:
<write_file path="relative/path">
file content here
</write_file>

To partially edit a file (preferred for small changes):
<edit_file path="relative/path">
<<<<<<< SEARCH
exact existing content
=======
replacement content
>>>>>>> REPLACE
</edit_file>

Be concise. Deliver your complete answer in a single response.`

const (
	headerLines = 4 // brand + tagline + meta + rule
)

func New(cwd string) Model {
	ui := textinput.New()
	ui.Placeholder = "https://..."
	ui.CharLimit = 300
	ui.Width = 50

	ci := textinput.New()
	ci.Prompt = "  ❯  "
	ci.PromptStyle = lipgloss.NewStyle().Foreground(cCyan).Bold(true)
	ci.Placeholder = "ask anything  ·  @file  ·  ctrl+o browse files  ·  /exit"
	ci.CharLimit = 4000

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(cYellow)

	return Model{
		screen:    screenProviderPick,
		cwd:       cwd,
		urlInput:  ui,
		chatInput: ci,
		sp:        sp,
		messages:  []llm.Message{{Role: "system", Content: systemPrompt}},
	}
}

func (m Model) Init() tea.Cmd { return nil }

// ── commands ──────────────────────────────────────────────────────────────────

func cmdFetch(p llm.Provider) tea.Cmd {
	return func() tea.Msg {
		models, err := p.ListModels(context.Background())
		return modelsMsg{models: models, err: err}
	}
}

func cmdChat(p llm.Provider, model string, msgs []llm.Message) tea.Cmd {
	return func() tea.Msg {
		contentChan, err := p.Chat(context.Background(), model, msgs)
		if err != nil {
			return chatMsg{err: err}
		}
		var content strings.Builder
		for chunk := range contentChan {
			content.WriteString(chunk)
		}
		return chatMsg{content: content.String()}
	}
}

// ── height helpers ────────────────────────────────────────────────────────────

// footerHeight counts lines below the viewport in the chat screen.
func (m Model) footerHeight() int {
	h := 6 // bottom-rule + input-border-top + input + input-border-bottom + options + gap
	if m.thinking {
		h++
	}
	if len(m.completions) > 0 {
		limit := min(6, len(m.completions))
		h += limit
		if len(m.completions) > limit {
			h++
		}
		h++ // rule above completions
	}
	return h
}

func (m Model) vpHeight() int {
	h := m.height - headerLines - m.footerHeight()
	if h < 3 {
		h = 3
	}
	return h
}

func (m Model) resync() Model {
	if !m.vpReady {
		return m
	}
	m.vp.Width = m.width
	m.vp.Height = m.vpHeight()
	return m
}

// ── Update ────────────────────────────────────────────────────────────────────

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.chatInput.Width = m.width - 10
		if !m.vpReady {
			m.vp = viewport.New(m.width, m.vpHeight())
			m.vpReady = true
		}
		m = m.resync()
		if m.screen == screenChat {
			m.vp.SetContent(m.renderMessages())
		}
		return m, nil

	case tea.KeyMsg:
		switch m.screen {
		case screenProviderPick:
			return m.updateProviderPick(msg)
		case screenURLInput:
			return m.updateURLInput(msg)
		case screenModelPick:
			return m.updateModelPick(msg)
		case screenChat:
			return m.updateChat(msg)
		case screenFileBrowser:
			return m.updateFileBrowser(msg)
		}

	case modelsMsg:
		if msg.err != nil {
			m.fetchErr = msg.err.Error()
			m.screen = screenURLInput
			m.urlInput.Focus()
			return m, nil
		}
		m.models = msg.models
		m.modelIdx = 0
		m.screen = screenModelPick
		return m, nil

	case chatMsg:
		m.thinking = false
		if msg.err != nil {
			m.messages = append(m.messages, llm.Message{
				Role:    "assistant",
				Content: sErr.Render("error: " + msg.err.Error()),
			})
		} else {
			parsed := files.ParseResponse(msg.content)
			var ops []string
			for _, w := range parsed.Writes {
				if err := files.ApplyWrite(w, m.cwd); err == nil {
					ops = append(ops, sOk.Render("✓ wrote ")+sDim.Render(w.Path))
				} else {
					ops = append(ops, sErr.Render("✗ "+w.Path+" — "+err.Error()))
				}
			}
			for _, e := range parsed.Edits {
				ok, err := files.ApplyEdit(e, m.cwd)
				switch {
				case err != nil:
					ops = append(ops, sErr.Render("✗ "+e.Path+" — "+err.Error()))
				case !ok:
					ops = append(ops, sErr.Render("✗ "+e.Path+" — search text not found"))
				default:
					ops = append(ops, sOk.Render("✓ edited ")+sDim.Render(e.Path))
				}
			}
			reply := parsed.Text
			if len(ops) > 0 {
				reply += "\n\n" + strings.Join(ops, "\n")
			}
			m.messages = append(m.messages, llm.Message{Role: "assistant", Content: reply})
		}
		m = m.resync()
		m.vp.SetContent(m.renderMessages())
		m.vp.GotoBottom()
		return m, nil

	case spinner.TickMsg:
		if m.thinking {
			var cmd tea.Cmd
			m.sp, cmd = m.sp.Update(msg)
			return m, cmd
		}
	}

	return m, nil
}

// ── screen updates ────────────────────────────────────────────────────────────

func (m Model) updateProviderPick(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		if m.providerIdx > 0 {
			m.providerIdx--
		}
	case "down", "j":
		if m.providerIdx < 1 {
			m.providerIdx++
		}
	case "enter":
		if m.providerIdx == 0 {
			m.provider = llm.NewOllama("")
			m.screen = screenFetchModels
			return m, cmdFetch(m.provider)
		}
		m.fetchErr = ""
		m.urlInput.SetValue("")
		m.screen = screenURLInput
		m.urlInput.Focus()
	}
	return m, nil
}

func (m Model) updateURLInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		m.screen = screenProviderPick
		m.urlInput.Blur()
		m.fetchErr = ""
		return m, nil
	case "enter":
		raw := strings.TrimSpace(m.urlInput.Value())
		if raw == "" {
			raw = "http://localhost:11434"
		}
		if m.providerIdx == 0 {
			m.provider = llm.NewOllama(raw)
		} else {
			m.provider = llm.NewOpenAI(raw, "")
		}
		m.screen = screenFetchModels
		m.urlInput.Blur()
		return m, cmdFetch(m.provider)
	}
	var cmd tea.Cmd
	m.urlInput, cmd = m.urlInput.Update(msg)
	return m, cmd
}

func (m Model) updateModelPick(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "esc":
		m.screen = screenProviderPick
	case "up", "k":
		if m.modelIdx > 0 {
			m.modelIdx--
		}
	case "down", "j":
		if m.modelIdx < len(m.models)-1 {
			m.modelIdx++
		}
	case "enter":
		if len(m.models) > 0 {
			m.selectedModel = m.models[m.modelIdx]
			m.screen = screenChat
			m.chatInput.Focus()
			if m.vpReady {
				m.vp.SetContent(m.renderMessages())
			}
		}
	}
	return m, nil
}

func (m Model) updateChat(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.thinking {
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		return m, nil
	}

	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit

	case "ctrl+o":
		// open file browser
		m.prevScreen = screenChat
		m.fbDir = m.cwd
		m.fbItems = loadFBItems(m.fbDir)
		m.fbCursor = 0
		m.screen = screenFileBrowser
		return m, nil

	case "ctrl+l":
		// clear chat history (keep system prompt)
		m.messages = m.messages[:1]
		m.vp.SetContent("")
		m.vp.GotoBottom()
		return m, nil

	case "esc":
		if len(m.completions) > 0 {
			m.completions = nil
			m.compIdx = 0
			m = m.resync()
			return m, nil
		}
		return m, tea.Quit

	case "tab":
		if len(m.completions) > 0 {
			m.compIdx = (m.compIdx + 1) % len(m.completions)
			m.chatInput.SetValue(applyCompletion(m.chatInput.Value(), m.completions[m.compIdx]))
			m = m.refreshCompletions()
			m = m.resync()
		}
		return m, nil

	case "pgup", "pgdown":
		var cmd tea.Cmd
		m.vp, cmd = m.vp.Update(msg)
		return m, cmd

	case "enter":
		text := strings.TrimSpace(m.chatInput.Value())
		if text == "" {
			return m, nil
		}
		if text == "/exit" || text == "/quit" {
			return m, tea.Quit
		}
		refs := files.ResolveAtMentions(text, m.cwd)
		content := text
		for _, r := range refs {
			content += fmt.Sprintf("\n\n--- %s ---\n```\n%s\n```", r.Path, r.Content)
		}
		m.messages = append(m.messages, llm.Message{Role: "user", Content: content})
		m.chatInput.SetValue("")
		m.completions = nil
		m.compIdx = 0
		m.thinking = true
		m = m.resync()
		m.vp.SetContent(m.renderMessages())
		m.vp.GotoBottom()
		return m, tea.Batch(cmdChat(m.provider, m.selectedModel, m.messages), m.sp.Tick)
	}

	var cmd tea.Cmd
	m.chatInput, cmd = m.chatInput.Update(msg)
	m = m.refreshCompletions()
	m = m.resync()
	return m, cmd
}

func (m Model) updateFileBrowser(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit

	case "esc", "q":
		m.screen = m.prevScreen
		m.chatInput.Focus()
		return m, nil

	case "up", "k":
		if m.fbCursor > 0 {
			m.fbCursor--
		}

	case "down", "j":
		if m.fbCursor < len(m.fbItems)-1 {
			m.fbCursor++
		}

	case "right", "enter", "l":
		if len(m.fbItems) == 0 {
			break
		}
		item := m.fbItems[m.fbCursor]
		if item.isDir {
			m.fbDir = filepath.Join(m.fbDir, item.name)
			m.fbItems = loadFBItems(m.fbDir)
			m.fbCursor = 0
		} else {
			// select file → add @relpath to chat input
			rel := m.fbRelPath(item.name)
			m.chatInput.SetValue(m.chatInput.Value() + "@" + rel)
			m.screen = m.prevScreen
			m.chatInput.Focus()
			m = m.refreshCompletions()
		}

	case "left", "backspace", "h":
		// go to parent (cap at filesystem root)
		parent := filepath.Dir(m.fbDir)
		if parent != m.fbDir {
			m.fbDir = parent
			m.fbItems = loadFBItems(m.fbDir)
			m.fbCursor = 0
		}

	case " ":
		// select current item regardless of type
		if len(m.fbItems) == 0 {
			break
		}
		item := m.fbItems[m.fbCursor]
		rel := m.fbRelPath(item.name)
		if item.isDir {
			rel += "/"
		}
		m.chatInput.SetValue(m.chatInput.Value() + "@" + rel)
		m.screen = m.prevScreen
		m.chatInput.Focus()
		m = m.refreshCompletions()
	}

	return m, nil
}

// fbRelPath returns the path of name relative to cwd (falls back to absolute).
func (m Model) fbRelPath(name string) string {
	abs := filepath.Join(m.fbDir, name)
	rel, err := filepath.Rel(m.cwd, abs)
	if err != nil || strings.HasPrefix(rel, ".."+string(filepath.Separator)+"..") {
		return abs
	}
	return rel
}

func (m Model) refreshCompletions() Model {
	partial, ok := extractAtPartial(m.chatInput.Value())
	if !ok {
		m.completions = nil
		m.compIdx = 0
		return m
	}
	m.completions = getCompletions(partial, m.cwd)
	if m.compIdx >= len(m.completions) {
		m.compIdx = 0
	}
	return m
}

// ── message rendering ─────────────────────────────────────────────────────────

func (m Model) renderMessages() string {
	var b strings.Builder
	contentW := m.width - 7
	if m.vpReady && m.vp.Width > 7 {
		contentW = m.vp.Width - 7
	}
	if contentW < 20 {
		contentW = 20
	}
	wrap := lipgloss.NewStyle().Width(contentW)

	for _, msg := range m.messages {
		if msg.Role == "system" {
			continue
		}
		if msg.Role == "user" {
			b.WriteString(" " + sUser.Render("◆") + "  " + sUser.Render("you") + "\n")
		} else {
			b.WriteString(" " + sAssist.Render("◇") + "  " + sAssist.Render("miii") + "\n")
		}
		rendered := wrap.Render(msg.Content)
		for _, line := range strings.Split(rendered, "\n") {
			b.WriteString("    " + strings.TrimRight(line, " ") + "\n")
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// ── View ──────────────────────────────────────────────────────────────────────

func (m Model) View() string {
	switch m.screen {
	case screenProviderPick:
		return m.viewProviderPick()
	case screenURLInput:
		return m.viewURLInput()
	case screenFetchModels:
		return m.viewFetching()
	case screenModelPick:
		return m.viewModelPick()
	case screenChat:
		return m.viewChat()
	case screenFileBrowser:
		return m.viewFileBrowser()
	}
	return ""
}

func rule(w int) string {
	if w < 2 {
		w = 60
	}
	return sDim.Render(strings.Repeat("─", w))
}

// ── setup screen views ────────────────────────────────────────────────────────

func setupHeader() string {
	var b strings.Builder
	b.WriteString("\n  " + sBrand.Render("MIII") + "\n")
	b.WriteString("  " + sTagline.Render("Claude Code Experience. Powered by Your Own Models.") + "\n\n")
	return b.String()
}

func (m Model) viewProviderPick() string {
	boxW := min(m.width-4, 64)

	var inner strings.Builder
	inner.WriteString(sDim.Render("provider") + "\n\n")

	rows := []struct{ label, detail string }{
		{"Ollama", "localhost:11434  (default)"},
		{"Custom", "OpenAI-compatible endpoint"},
	}
	labelW := lipgloss.NewStyle().Width(10)
	for i, r := range rows {
		label := labelW.Render(r.label)
		detail := sHint.Render(r.detail)
		if i == m.providerIdx {
			inner.WriteString(sSel.Render("›") + "  " + sSel.Render(label) + "  " + detail + "\n")
		} else {
			inner.WriteString(sDim.Render("·") + "  " + label + "  " + detail + "\n")
		}
	}
	inner.WriteString("\n" + sHint.Render("↑↓  move    enter  select    q  quit"))

	return setupHeader() + "  " + sSetupBox.Width(boxW).Render(inner.String()) + "\n"
}

func (m Model) viewURLInput() string {
	boxW := min(m.width-4, 64)

	var inner strings.Builder
	inner.WriteString(sDim.Render("base url") + "\n\n")
	inner.WriteString(m.urlInput.View() + "\n")
	if m.fetchErr != "" {
		inner.WriteString("\n" + sErr.Render("✗  "+m.fetchErr) + "\n")
	}
	inner.WriteString("\n" + sHint.Render("enter  confirm    esc  back"))

	return setupHeader() + "  " + sSetupBox.Width(boxW).Render(inner.String()) + "\n"
}

func (m Model) viewFetching() string {
	return setupHeader() + "  " + sDim.Render("fetching models...") + "\n"
}

func (m Model) viewModelPick() string {
	boxW := min(m.width-4, 64)

	var inner strings.Builder
	inner.WriteString(sDim.Render("model") + "\n\n")
	for i, name := range m.models {
		if i == m.modelIdx {
			inner.WriteString(sSel.Render("›  "+name) + "\n")
		} else {
			inner.WriteString(sDim.Render("·") + "  " + name + "\n")
		}
	}
	inner.WriteString("\n" + sHint.Render("↑↓  move    enter  select    esc  back"))

	return setupHeader() + "  " + sSetupBox.Width(boxW).Render(inner.String()) + "\n"
}

// ── chat screen view ──────────────────────────────────────────────────────────

func (m Model) viewChat() string {
	var b strings.Builder

	// ── header (4 lines) ──
	b.WriteString(" " + sBrand.Render("MIII") + "\n")
	b.WriteString(" " + sTagline.Render("Claude Code Experience. Powered by Your Own Models.") + "\n")
	b.WriteString(" " + sDim.Render(m.selectedModel+"  ·  "+m.cwd) + "\n")
	b.WriteString(rule(m.width) + "\n")

	// ── viewport ──
	if m.vpReady {
		b.WriteString(m.vp.View())
		b.WriteByte('\n')
	}

	// ── bottom rule ──
	b.WriteString(rule(m.width) + "\n")

	// ── thinking ──
	if m.thinking {
		b.WriteString(" " + m.sp.View() + " " + sDim.Render("thinking...") + "\n")
	}

	// ── @ completions ──
	if len(m.completions) > 0 {
		limit := min(6, len(m.completions))
		for i, c := range m.completions[:limit] {
			if i == m.compIdx {
				b.WriteString(" " + sCompSel.Render("  "+c+"  ") + "\n")
			} else {
				b.WriteString(" " + sDim.Render("  "+c) + "\n")
			}
		}
		if len(m.completions) > limit {
			b.WriteString(" " + sHint.Render(fmt.Sprintf("  +%d more", len(m.completions)-limit)) + "\n")
		}
		b.WriteString(rule(m.width) + "\n")
	}

	// ── input box ──
	inputContent := m.chatInput.View()
	inputBox := sInputBorder.Width(m.width - 4).Render(inputContent)
	b.WriteString(inputBox + "\n")

	// ── options bar ──
	b.WriteString(m.optionsBar())

	return b.String()
}

func (m Model) optionsBar() string {
	browse := sBtn.Render("  Files  ctrl+o  ")
	clear := sBtn.Render("  Clear  ctrl+l  ")
	model := sBtnActive.Render("  " + m.selectedModel + "  ")
	exit := sBtn.Render("  /exit  ")
	pgScroll := sHint.Render("  PgUp/PgDn scroll  ")

	gap := "  "
	return " " + browse + gap + clear + gap + model + gap + exit + gap + pgScroll + "\n"
}

// ── file browser view ─────────────────────────────────────────────────────────

func (m Model) viewFileBrowser() string {
	var b strings.Builder

	// header
	b.WriteString(" " + sBrand.Render("Miii") + "  " + sDim.Render("Browse Files") + "\n")
	b.WriteString(" " + sTagline.Render("Claude Code Experience. Powered by Your Own Models.") + "\n")
	b.WriteString(rule(m.width) + "\n\n")

	// current path
	rel, _ := filepath.Rel(m.cwd, m.fbDir)
	if rel == "." {
		rel = "./"
	} else if !strings.HasPrefix(rel, "..") {
		rel = "./" + rel + "/"
	}
	b.WriteString(" " + sDim.Render(rel) + "\n\n")

	// entries
	maxVisible := m.height - 10
	if maxVisible < 4 {
		maxVisible = 4
	}
	start := 0
	if m.fbCursor >= start+maxVisible {
		start = m.fbCursor - maxVisible + 1
	}
	end := min(start+maxVisible, len(m.fbItems))

	if len(m.fbItems) == 0 {
		b.WriteString(" " + sDim.Render("(empty)") + "\n")
	}
	for i, item := range m.fbItems[start:end] {
		idx := start + i
		var label string
		if item.isDir {
			label = sDir.Render(item.name + "/")
		} else {
			label = sFile.Render(item.name)
		}
		if idx == m.fbCursor {
			b.WriteString(" " + sSel.Render("›") + "  " + label + "\n")
		} else {
			b.WriteString("    " + label + "\n")
		}
	}
	if len(m.fbItems) > maxVisible {
		b.WriteString(" " + sHint.Render(fmt.Sprintf("  %d/%d items", m.fbCursor+1, len(m.fbItems))) + "\n")
	}

	b.WriteString("\n" + rule(m.width) + "\n")
	b.WriteString(" " + sHint.Render("↑↓ / jk  navigate    →/enter  open    ←/back  parent    space  pick    esc  close"))

	return b.String()
}
