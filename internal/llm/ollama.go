package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type Ollama struct {
	BaseURL string
}

func NewOllama(baseURL string) *Ollama {
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	return &Ollama{BaseURL: baseURL}
}

func (o *Ollama) ListModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.BaseURL+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama unreachable at %s: %w", o.BaseURL, err)
	}
	defer resp.Body.Close()

	var result struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	names := make([]string, len(result.Models))
	for i, m := range result.Models {
		names[i] = m.Name
	}
	return names, nil
}

func (o *Ollama) Chat(ctx context.Context, model string, messages []Message) (<-chan string, error) {
	ch := make(chan string, 10)
	go func() {
		defer close(ch)
		body, _ := json.Marshal(map[string]any{
			"model":    model,
			"messages": messages,
			"stream":   true,
		})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.BaseURL+"/api/chat", bytes.NewReader(body))
		if err != nil {
			ch <- fmt.Sprintf("Error: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			ch <- fmt.Sprintf("Error: ollama unreachable: %v", err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			ch <- fmt.Sprintf("Error: ollama: %s", resp.Status)
			return
		}
		decoder := json.NewDecoder(resp.Body)
		for {
			var chunk struct {
				Done    bool   `json:"done"`
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			}
			if err := decoder.Decode(&chunk); err != nil {
				ch <- fmt.Sprintf("Error: %v", err)
				return
			}
			ch <- chunk.Message.Content
			if chunk.Done {
				break
			}
		}
	}()
	return ch, nil
}
