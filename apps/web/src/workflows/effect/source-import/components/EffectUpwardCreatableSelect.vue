<script setup lang="ts">
import { Check, ChevronDown, Plus, Search } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type SelectValue = number | string;
type SelectOption = { label: string; value: SelectValue };

const props = withDefaults(
  defineProps<{
    fieldLabel: string;
    disabled?: boolean;
    modelValue: SelectValue;
    options: readonly SelectOption[];
    placeholder?: string;
  }>(),
  { disabled: false, placeholder: '请选择或输入自定义值' },
);

const emit = defineEmits<{ 'update:modelValue': [value: SelectValue] }>();
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref('');
const activeIndex = ref(0);
const menuStyle = ref<Record<string, string>>({});

const updateMenuPosition = (): void => {
  if (!root.value) return;
  const rect = root.value.getBoundingClientRect();
  const availableHeight = Math.max(112, rect.top - 16);
  menuStyle.value = {
    bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
    left: `${Math.max(8, rect.left)}px`,
    maxHeight: `${availableHeight}px`,
    width: `${Math.max(160, rect.width)}px`,
  };
};

const selectedLabel = computed(
  () =>
    props.options.find((option) => String(option.value) === String(props.modelValue))?.label ??
    String(props.modelValue ?? ''),
);

const filteredOptions = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase();
  if (!normalized) return [...props.options];
  return props.options.filter((option) =>
    `${option.label} ${String(option.value)}`.toLocaleLowerCase().includes(normalized),
  );
});

const canCreate = computed(() => {
  const value = query.value.trim();
  return (
    Boolean(value) &&
    !props.options.some(
      (option) =>
        option.label.toLocaleLowerCase() === value.toLocaleLowerCase() ||
        String(option.value).toLocaleLowerCase() === value.toLocaleLowerCase(),
    )
  );
});

const openMenu = async (): Promise<void> => {
  if (props.disabled) return;
  query.value = '';
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((option) => String(option.value) === String(props.modelValue)),
  );
  updateMenuPosition();
  open.value = true;
  await nextTick();
  updateMenuPosition();
  searchInput.value?.focus();
};

const closeMenu = (): void => {
  open.value = false;
  query.value = '';
};

const selectValue = (value: SelectValue): void => {
  emit('update:modelValue', value);
  closeMenu();
};

const createValue = (): void => {
  const value = query.value.trim();
  if (!value) return;
  const numeric = props.options.every((option) => typeof option.value === 'number');
  selectValue(numeric && Number.isFinite(Number(value)) ? Number(value) : value);
};

const onKeydown = (event: KeyboardEvent): void => {
  if (!open.value && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault();
    void openMenu();
    return;
  }
  if (!open.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, filteredOptions.value.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const option = filteredOptions.value[activeIndex.value];
    if (option) selectValue(option.value);
    else if (canCreate.value) createValue();
  }
};

const handleDocumentPointer = (event: MouseEvent): void => {
  const target = event.target as Node;
  if (root.value && !root.value.contains(target) && (!menu.value || !menu.value.contains(target)))
    closeMenu();
};

watch(query, () => {
  activeIndex.value = 0;
});
onMounted(() => {
  document.addEventListener('mousedown', handleDocumentPointer);
  window.addEventListener('resize', updateMenuPosition);
  window.addEventListener('scroll', updateMenuPosition, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentPointer);
  window.removeEventListener('resize', updateMenuPosition);
  window.removeEventListener('scroll', updateMenuPosition, true);
});
</script>

<template>
  <div ref="root" class="effect-up-select" :class="{ disabled, open }" @keydown="onKeydown">
    <button
      class="effect-up-select__trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="fieldLabel"
      :disabled="disabled"
      @click="open ? closeMenu() : openMenu()"
    >
      <span :class="{ placeholder: !selectedLabel }">{{ selectedLabel || placeholder }}</span>
      <ChevronDown :size="15" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="effect-up-select__menu"
        :style="menuStyle"
        @keydown="onKeydown"
      >
        <label class="effect-up-select__search">
          <Search :size="14" aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            autocomplete="off"
            :aria-label="`${fieldLabel}搜索`"
            placeholder="搜索或输入自定义值"
          />
        </label>
        <div class="effect-up-select__options" role="listbox" :aria-label="fieldLabel">
          <button
            v-for="(option, index) in filteredOptions"
            :key="`${String(option.value)}-${index}`"
            class="effect-up-select__option"
            :class="{ active: index === activeIndex }"
            type="button"
            role="option"
            :aria-selected="String(option.value) === String(modelValue)"
            @mouseenter="activeIndex = index"
            @click="selectValue(option.value)"
          >
            <span>{{ option.label }}</span>
            <Check
              v-if="String(option.value) === String(modelValue)"
              :size="14"
              aria-hidden="true"
            />
          </button>
          <button
            v-if="canCreate"
            class="effect-up-select__option create"
            type="button"
            @click="createValue"
          >
            <Plus :size="14" aria-hidden="true" />使用“{{ query.trim() }}”
          </button>
          <p v-if="!filteredOptions.length && !canCreate" class="effect-up-select__empty">
            没有匹配项
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.effect-up-select {
  position: relative;
  width: 100%;
}
.effect-up-select__trigger {
  display: flex;
  width: 100%;
  min-height: 38px;
  padding: 0 11px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #26344d;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 8px;
  text-align: left;
  transition: 0.18s ease;
}
.effect-up-select__trigger:hover,
.effect-up-select.open .effect-up-select__trigger {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb12;
}
.effect-up-select__trigger svg {
  flex: 0 0 auto;
  color: #7b8799;
  transition: transform 0.18s ease;
}
.effect-up-select.open .effect-up-select__trigger svg {
  transform: rotate(180deg);
}
.effect-up-select__trigger .placeholder {
  color: #9aa5b5;
}
.effect-up-select__menu {
  position: fixed;
  z-index: 2200;
  display: flex;
  padding: 8px;
  box-sizing: border-box;
  flex-direction: column;
  background: #fff;
  border: 1px solid #dbe4f2;
  border-radius: 11px;
  box-shadow: 0 16px 38px #17233a20;
}
.effect-up-select__search {
  display: flex;
  height: 34px;
  padding: 0 9px;
  align-items: center;
  gap: 7px;
  color: #8190a5;
  background: #f7faff;
  border: 1px solid #dfe7f3;
  border-radius: 7px;
}
.effect-up-select__search input {
  width: 100%;
  min-width: 0;
  color: #26344d;
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 12px;
}
.effect-up-select__options {
  min-height: 0;
  margin-top: 6px;
  flex: 1;
  overflow: auto;
}
.effect-up-select__option {
  display: flex;
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  color: #40506a;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
}
.effect-up-select__option:hover,
.effect-up-select__option.active {
  color: #2563eb;
  background: #edf4ff;
}
.effect-up-select__option.create {
  justify-content: flex-start;
  color: #2563eb;
  border-top: 1px solid #edf0f5;
}
.effect-up-select__empty {
  margin: 0;
  padding: 14px 8px;
  color: #9aa5b5;
  font-size: 12px;
  text-align: center;
}
.effect-up-select.disabled {
  opacity: 0.58;
}
</style>
