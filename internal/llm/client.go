package llm

import "context"

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Provider interface {
	ListModels(ctx context.Context) ([]string, error)
	Chat(ctx context.Context, model string, messages []Message) (<-chan string, error)
}
