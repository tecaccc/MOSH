<script lang="ts">
  /** 日视图：当前 cursor 当日的全天带 + 时间轴。 */
  import { cursor } from "../../calendar.svelte";
  import TimeGrid from "./TimeGrid.svelte";

  const days = $derived([cursor()]);
</script>

<TimeGrid days={days} />
