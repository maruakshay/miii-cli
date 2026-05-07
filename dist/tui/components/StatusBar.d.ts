import type { Status } from '../../types.js';
interface Props {
    model: string;
    provider: string;
    status: Status;
    tick: number;
}
export declare function StatusBar({ model, provider, status, tick }: Props): import("react/jsx-runtime").JSX.Element;
export declare function Divider({ cols }: {
    cols: number;
}): import("react/jsx-runtime").JSX.Element;
export {};
