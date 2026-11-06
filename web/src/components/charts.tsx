// the charts, loaded on their own after the page: echarts is most of their weight, and nothing
// else waits for it. only what kumo's charts use is registered, with the svg renderer: kumo's
// components don't register one of their own, and echarts can't draw without one
import { Chart, TimeseriesChart } from "@cloudflare/kumo/components/chart"
import { BarChart, LineChart } from "echarts/charts"
import { AriaComponent, AxisPointerComponent, BrushComponent, GridComponent, MarkLineComponent, ToolboxComponent, TooltipComponent } from "echarts/components"
import * as echarts from "echarts/core"
import { SVGRenderer } from "echarts/renderers"

// brush and toolbox: kumo's timeseries chart uses them for drag-to-select a time range
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  MarkLineComponent,
  AriaComponent,
  BrushComponent,
  ToolboxComponent,
  SVGRenderer,
])

export const COLOR = { light: "#2f7bf5", dark: "#5b9bff" }

export interface SeriesProps {
  readonly name: string
  readonly data: Array<[number, number]>
  readonly dark: boolean
  readonly format: (value: number) => string
}

/** a card's main chart: time along the bottom, values on the right */
export const AreaChart = ({ name, data, dark, format, type = "line" }: SeriesProps & { readonly type?: "line" | "bar" }) => (
  <TimeseriesChart
    echarts={echarts}
    isDarkMode={dark}
    type={type}
    gradient
    height={190}
    data={[{ name, data, color: dark ? COLOR.dark : COLOR.light }]}
    yAxisTickCount={4}
    yAxisMinInterval={1}
    yAxisTickFormat={format}
    tooltipValueFormat={format}
    xAxisTickCount={5}
  />
)

/** edge to edge, no axes: the small cards */
export const Sparkline = ({ name, data, dark, format }: SeriesProps) => {
  const color = dark ? COLOR.dark : COLOR.light
  return (
    <Chart
      echarts={echarts}
      isDarkMode={dark}
      height={120}
      options={{
        backgroundColor: "transparent",
        animation: false,
        grid: { left: 0, right: 0, top: 6, bottom: 0 },
        tooltip: { trigger: "axis", valueFormatter: (v) => format(Number(v)) },
        xAxis: { type: "time", show: false },
        yAxis: { type: "value", show: false, min: 0 },
        series: [
          {
            name,
            type: "line",
            data,
            showSymbol: false,
            lineStyle: { width: 1.5, color },
            itemStyle: { color },
            areaStyle: { color: dark ? "rgba(91,155,255,0.14)" : "rgba(47,123,245,0.10)" },
          },
        ],
      }}
    />
  )
}
