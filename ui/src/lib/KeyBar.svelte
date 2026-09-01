<script>
  import Kbd from "./Kbd.svelte";

  let { keys } = $props();
</script>

<div class="keybar" aria-label="Keyboard shortcuts">
  <div class="keybar-content">
    {#each keys as { key, label }}
      <span class="hint">
        <Kbd keys={key} />
        <span class="label">{label}</span>
      </span>
    {/each}
  </div>
</div>

<style>
  .keybar {
    position: fixed;
    left: var(--app-rail-width, 0px);
    right: 0;
    bottom: 0;
    z-index: 20;
    height: var(--keybar-height);
    padding: 0 var(--app-content-gutter, 28px);
    overflow-x: auto;
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .keybar-content {
    display: flex;
    box-sizing: border-box;
    width: fit-content;
    max-width: var(--app-content-max-width, 1320px);
    min-height: 100%;
    align-items: center;
    gap: 16px;
    margin: 0 auto;
    padding-inline: 2px;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  .label {
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11.5px;
  }

  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .keybar {
      display: none;
    }
  }
</style>
