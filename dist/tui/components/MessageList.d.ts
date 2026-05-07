import type { Message } from '../../types.js';
interface Props {
    messages: Message[];
    rows: number;
    cols: number;
    scrollOffset: number;
    streaming?: boolean;
}
export declare function MessageList({ messages, rows, cols, scrollOffset, streaming }: Props): import("react/jsx-runtime").JSX.Element;
export {};
