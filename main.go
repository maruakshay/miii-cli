package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"miii/internal/ui"
)

func main() {
	cwd, _ := os.Getwd()
	p := tea.NewProgram(ui.New(cwd), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
