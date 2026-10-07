import { onBeforeUnmount, onMounted, ref } from 'vue';

/** Only warm media close to the screen, including inside clipped scroll panels. */
export const useEffectTemplateMixMediaVisibility = () => {
  const host = ref<HTMLElement | null>(null);
  const visible = ref(typeof IntersectionObserver === 'undefined');
  let observer: IntersectionObserver | undefined;
  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined' || !host.value) return;
    observer = new IntersectionObserver(([entry]) => {
      visible.value = entry?.isIntersecting ?? false;
    }, { rootMargin: '200px' });
    observer.observe(host.value);
  });
  onBeforeUnmount(() => observer?.disconnect());
  return { host, visible };
};
