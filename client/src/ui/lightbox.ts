import { ref } from 'vue';

/** 全局图片灯箱状态（模块级单例，App 挂载一次 ImageLightbox 组件） */
export const lightboxUrl = ref<string | null>(null);
export const lightboxName = ref('');

export function openLightbox(url: string, name = ''): void {
  lightboxUrl.value = url;
  lightboxName.value = name;
}

export function closeLightbox(): void {
  lightboxUrl.value = null;
  lightboxName.value = '';
}
