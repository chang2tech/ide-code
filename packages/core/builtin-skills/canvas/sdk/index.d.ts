/**
 * Public API for authoring `.canvas.tsx` files via `ide/canvas`.
 *
 * This is the IDE Code canvas SDK. A canvas is a single `.canvas.tsx` file
 * that the IDE compiles and renders beside the chat. Read the `canvas`
 * built-in skill (`SKILL.md` next to this directory) for the full workflow
 * and design guidance before writing a canvas.
 *
 * Key constraints (see SKILL.md):
 * - Import ONLY from `ide/canvas`. No relative imports, no npm packages, no Node built-ins.
 * - Default-export the top-level component.
 * - Embed all data inline. No `fetch()`, no network calls.
 * - Colors come from `useHostTheme()` tokens. No hardcoded hex.
 * - No gradients, no box-shadows, no emojis as decoration.
 * - Never render empty states: omit sections that have no data.
 */
declare module "ide/canvas" {
  import type { CSSProperties, ReactElement, ReactNode } from "react";

  export type { CSSProperties };
  export { useEffect, useMemo, useRef, useState } from "react";

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  /** Semantic color groups, available directly on the object returned by `useHostTheme()`. */
  export interface HostTheme {
    readonly kind: "dark" | "light";
    readonly text: {
      readonly primary: string;
      readonly secondary: string;
      readonly tertiary: string;
      readonly quaternary: string;
    };
    readonly bg: {
      readonly editor: string;
      readonly chrome: string;
      readonly elevated: string;
    };
    readonly fill: {
      readonly primary: string;
      readonly secondary: string;
      readonly tertiary: string;
      readonly quaternary: string;
    };
    readonly stroke: {
      readonly primary: string;
      readonly secondary: string;
      readonly tertiary: string;
    };
    readonly accent: {
      readonly primary: string;
      readonly control: string;
    };
    readonly diff: {
      readonly added: string;
      readonly removed: string;
    };
    /** Shallow-merge two style objects. Useful for combining tokens with overrides. */
    readonly mergeStyle: (...styles: (CSSProperties | undefined)[]) => CSSProperties;
  }

  /** Returns the current host theme. Call inside each component that needs theme access. */
  export function useHostTheme(): HostTheme;

  /** Categorical color for charts and swatches. */
  export type ChartTone = "blue" | "green" | "yellow" | "orange" | "red" | "purple" | "cyan" | "gray";

  // ---------------------------------------------------------------------------
  // Canvas state + actions
  // ---------------------------------------------------------------------------

  /** Persist small UI state (selection, tab, expanded rows) across re-renders of this canvas. */
  export function useCanvasState<T>(key: string, initial: T): [T, (next: T) => void];

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  export interface StackProps {
    readonly children?: ReactNode;
    readonly gap?: number;
    readonly style?: CSSProperties;
  }
  export function Stack(props: StackProps): ReactElement;

  export interface RowProps {
    readonly children?: ReactNode;
    readonly gap?: number;
    readonly align?: "start" | "center" | "end" | "stretch";
    readonly justify?: "start" | "center" | "end" | "space-between";
    readonly wrap?: boolean;
    readonly style?: CSSProperties;
  }
  export function Row(props: RowProps): ReactElement;

  export interface GridProps {
    readonly children?: ReactNode;
    readonly columns?: number | string;
    readonly gap?: number;
    readonly style?: CSSProperties;
  }
  export function Grid(props: GridProps): ReactElement;

  export function Spacer(props: { readonly size?: number }): ReactElement;
  export function Divider(props?: { readonly style?: CSSProperties }): ReactElement;

  // ---------------------------------------------------------------------------
  // Typography
  // ---------------------------------------------------------------------------

  export type TextWeight = 400 | 500 | 590 | 600 | 700;

  export interface TextProps {
    readonly children?: ReactNode;
    readonly weight?: TextWeight;
    readonly color?: string;
    readonly size?: number;
    readonly style?: CSSProperties;
  }
  export function Text(props: TextProps): ReactElement;
  export function H1(props: TextProps): ReactElement;
  export function H2(props: TextProps): ReactElement;
  export function H3(props: TextProps): ReactElement;

  export interface CodeProps {
    readonly children?: ReactNode;
    readonly language?: string;
    readonly style?: CSSProperties;
  }
  export function Code(props: CodeProps): ReactElement;

  export interface LinkProps {
    readonly children?: ReactNode;
    readonly href: string;
    readonly style?: CSSProperties;
  }
  export function Link(props: LinkProps): ReactElement;

  // ---------------------------------------------------------------------------
  // Surfaces
  // ---------------------------------------------------------------------------

  export type CardVariant = "default" | "borderless";
  export interface CardProps {
    readonly children?: ReactNode;
    readonly variant?: CardVariant;
    readonly style?: CSSProperties;
  }
  export function Card(props: CardProps): ReactElement;

  export interface CardHeaderProps {
    readonly children?: ReactNode;
    readonly trailing?: ReactNode;
    readonly style?: CSSProperties;
  }
  export function CardHeader(props: CardHeaderProps): ReactElement;

  export function CardBody(props: { readonly children?: ReactNode; readonly padding?: number; readonly style?: CSSProperties }): ReactElement;

  export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";
  export interface CalloutProps {
    readonly children?: ReactNode;
    readonly tone?: CalloutTone;
    readonly title?: string;
    readonly style?: CSSProperties;
  }
  export function Callout(props: CalloutProps): ReactElement;

  export type PillTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";
  export interface PillProps {
    readonly children?: ReactNode;
    readonly tone?: PillTone;
    readonly style?: CSSProperties;
  }
  export function Pill(props: PillProps): ReactElement;

  export interface CollapsibleSectionProps {
    readonly title: ReactNode;
    readonly children?: ReactNode;
    readonly defaultOpen?: boolean;
    readonly style?: CSSProperties;
  }
  export function CollapsibleSection(props: CollapsibleSectionProps): ReactElement;

  // ---------------------------------------------------------------------------
  // Data display
  // ---------------------------------------------------------------------------

  export interface StatProps {
    readonly label: string;
    readonly value: ReactNode;
    readonly delta?: string;
    readonly tone?: "neutral" | "positive" | "negative";
    readonly style?: CSSProperties;
  }
  export function Stat(props: StatProps): ReactElement;

  export type TableColumnAlign = "left" | "center" | "right";
  export interface TableColumn<T> {
    readonly key: string;
    readonly header: ReactNode;
    readonly align?: TableColumnAlign;
    readonly render: (row: T) => ReactNode;
  }
  export interface TableProps<T> {
    readonly columns: ReadonlyArray<TableColumn<T>>;
    readonly rows: ReadonlyArray<T>;
    readonly rowKey?: (row: T, index: number) => string;
    readonly style?: CSSProperties;
  }
  export function Table<T>(props: TableProps<T>): ReactElement;

  export interface SwatchProps {
    readonly tone: ChartTone;
    readonly style?: CSSProperties;
  }
  export function Swatch(props: SwatchProps): ReactElement;

  export interface UsageBarSegment {
    readonly value: number;
    readonly tone: ChartTone;
    readonly label?: string;
  }
  export interface UsageBarProps {
    readonly segments: ReadonlyArray<UsageBarSegment>;
    readonly height?: number;
    readonly showLabels?: boolean;
    readonly style?: CSSProperties;
  }
  export function UsageBar(props: UsageBarProps): ReactElement;

  export interface TodoItem {
    readonly id: string;
    readonly title: string;
    readonly status: "pending" | "in-progress" | "done";
  }
  export function TodoList(props: { readonly items: ReadonlyArray<TodoItem>; readonly style?: CSSProperties }): ReactElement;

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------

  export interface ChartDataPoint {
    readonly label: string;
    readonly value: number;
  }
  export interface ChartSeries {
    readonly name: string;
    readonly tone?: ChartTone;
    readonly points: ReadonlyArray<ChartDataPoint>;
  }
  export interface ChartReferenceLine {
    readonly value: number;
    readonly label?: string;
  }
  export interface ChartAxisProps {
    readonly height?: number;
    readonly valuePrefix?: string;
    readonly valueSuffix?: string;
    readonly beginAtZero?: boolean;
    readonly yMin?: number;
    readonly yMax?: number;
    readonly referenceLines?: ReadonlyArray<ChartReferenceLine>;
    readonly style?: CSSProperties;
  }

  export interface BarChartProps extends ChartAxisProps {
    readonly categories: ReadonlyArray<string>;
    readonly series: ReadonlyArray<ChartSeries>;
    readonly stacked?: boolean;
    readonly horizontal?: boolean;
    readonly normalized?: boolean;
    readonly showValues?: boolean;
  }
  export function BarChart(props: BarChartProps): ReactElement;

  export interface LineChartProps extends ChartAxisProps {
    readonly categories: ReadonlyArray<string>;
    readonly series: ReadonlyArray<ChartSeries>;
    readonly fill?: boolean;
    readonly showValues?: boolean;
    readonly showHoverGuide?: boolean;
  }
  export function LineChart(props: LineChartProps): ReactElement;

  export interface PieChartProps {
    readonly data: ReadonlyArray<ChartDataPoint & { readonly tone?: ChartTone }>;
    readonly size?: number;
    readonly donut?: boolean;
    readonly style?: CSSProperties;
  }
  export function PieChart(props: PieChartProps): ReactElement;

  // ---------------------------------------------------------------------------
  // Diff
  // ---------------------------------------------------------------------------

  export type DiffLineType = "context" | "added" | "removed" | "hunk";
  export interface DiffLineData {
    readonly type: DiffLineType;
    readonly content: string;
  }
  export function DiffView(props: { readonly lines: ReadonlyArray<DiffLineData>; readonly style?: CSSProperties }): ReactElement;
  export function DiffStats(props: { readonly added: number; readonly removed: number }): ReactElement;

  // ---------------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------------

  export interface TextInputProps {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    readonly label?: string;
    readonly style?: CSSProperties;
  }
  export function TextInput(props: TextInputProps): ReactElement;

  export interface TextAreaProps extends TextInputProps {
    readonly rows?: number;
  }
  export function TextArea(props: TextAreaProps): ReactElement;

  export interface SelectOption {
    readonly value: string;
    readonly label: string;
  }
  export interface SelectProps {
    readonly value: string;
    readonly options: ReadonlyArray<SelectOption>;
    readonly onChange: (value: string) => void;
    readonly label?: string;
    readonly style?: CSSProperties;
  }
  export function Select(props: SelectProps): ReactElement;

  export interface ToggleProps {
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
    readonly label?: string;
    readonly style?: CSSProperties;
  }
  export function Toggle(props: ToggleProps): ReactElement;

  export interface CheckboxProps extends ToggleProps {}
  export function Checkbox(props: CheckboxProps): ReactElement;

  export interface ButtonProps {
    readonly children?: ReactNode;
    readonly onClick?: () => void;
    readonly variant?: "primary" | "secondary";
    readonly disabled?: boolean;
    readonly style?: CSSProperties;
  }
  export function Button(props: ButtonProps): ReactElement;

  export interface IconButtonProps {
    readonly icon: string;
    readonly label: string;
    readonly onClick?: () => void;
    readonly style?: CSSProperties;
  }
  export function IconButton(props: IconButtonProps): ReactElement;
}
