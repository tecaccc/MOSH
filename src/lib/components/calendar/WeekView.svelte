<script lang="ts">
  /** 周视图：当前 cursor 所在周（周一首）的 7 天时间网格。 */
  import { cursor } from "../../calendar.svelte";
  import { addDays, mondayOfWeek } from "../../calendar-grid";
  import TimeGrid from "./TimeGrid.svelte";

  const days = $derived.by(() => {
    const start = mondayOfWeek(cursor());
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  });
</script>

<TimeGrid days={days} />
