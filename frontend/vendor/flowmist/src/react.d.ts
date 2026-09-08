import type { HTMLAttributes, ReactElement } from 'react';
import type { FlowMistOptions } from './index.js';
export interface FlowMistProps extends FlowMistOptions, Omit<HTMLAttributes<HTMLDivElement>, 'onError' | 'children'> {label?: string;}
export function FlowMist(props: FlowMistProps): ReactElement;
