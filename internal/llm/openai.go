package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type OpenAI struct {
	BaseURL string
	APIKey  string
}

func NewOpenAI(baseURL, apiKey string) *OpenAI {
	return &OpenAI{BaseURL: baseURL, APIKey: apiKey}
}

func (o *OpenAI) ListModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.BaseURL+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	if o.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+o.APIKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("endpoint unreachable at %s: %w", o.BaseURL, err)
	}
	defer resp.Body.Close()

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	names := make([]string, len(result.Data))
	for i, m := range result.Data {
		names[i] = m.ID
	}
	return names, nil
}

func (o *OpenAI) Chat(ctx context.Context, model string, messages []Message) (<-chan string, error) {
	ch := make(chan string, 10)
	go func() {
		defer close(ch)
		body, _ := json.Marshal(map[string]any{
			"model":    model,
			"messages": messages,
			"stream":   true,
		})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
		if err != nil {
			ch <- fmt.Sprintf("Error: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if o.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+o.APIKey)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			ch <- fmt.Sprintf("Error: %v", err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			ch <- fmt.Sprintf("Error: api: %s", resp.Status)
			return
		}
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data: ") {
				data := line[6:]
				if data == "[DONE]" {
					break
				}
				var chunk struct {
					Choices []struct {
						Delta struct {
							Content string `json:"content"`
						} `json:"delta"`
					} `json:"choices"`
				}
				if err := json.Unmarshal([]byte(data), &chunk); err != nil {
					continue
				}
				if len(chunk.Choices) > 0 {
					ch <- chunk.Choices[0].Delta.Content
				}
			}
		}
		if err := scanner.Err(); err != nil {
			ch <- fmt.Sprintf("Error: %v", err)
		}
	}()
	return ch, nil
}
