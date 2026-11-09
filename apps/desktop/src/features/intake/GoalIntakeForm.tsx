import { useEffect, useRef, useState } from "react";
import { ImagePlus, Sparkles, Trash2 } from "lucide-react";
import type { IntakeHandling } from "../../../../../packages/core/src/types.js";
import { Button, ChoiceGroup, Field, LoadingState, Modal, TextArea } from "../../ui/index.js";

type IntakeImage = { key: string; file: File; preview: string };
const attachmentFormats = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function imageFile(file: File) {
  return attachmentFormats.has(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function GoalIntakeForm({
  busy,
  error,
  initialHandling = "concierge",
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  initialHandling?: IntakeHandling;
  onClose: () => void;
  onSubmit: (text: string, files: File[], handling: IntakeHandling) => Promise<void>;
}) {
  const [handling, setHandling] = useState<IntakeHandling>(initialHandling);
  const [images, setImages] = useState<IntakeImage[]>([]),
    [validation, setValidation] = useState(""),
    [dragging, setDragging] = useState(false),
    input = useRef<HTMLInputElement>(null),
    imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => {
    imagesRef.current.forEach(item => URL.revokeObjectURL(item.preview));
  }, []);
  function addFiles(incoming: File[]) {
    if (!incoming.length) return;
    const supported = incoming.filter(imageFile);
    let message = supported.length < incoming.length ? "只支持 PNG、JPEG、WebP 和 GIF 图片。" : "";
    if (supported.some(file => file.size > 10 * 1024 * 1024)) {
      setValidation("单张图片不能超过 10 MB。");
      return;
    }
    const accepted: IntakeImage[] = [];
    let total = images.reduce((sum, item) => sum + item.file.size, 0),
      count = images.length;
    for (const file of supported) {
      if (count >= 8) {
        message = "每个目标最多添加 8 张图片。";
        break;
      }
      if (total + file.size > 30 * 1024 * 1024) {
        message = "图片总计不能超过 30 MB。";
        break;
      }
      total += file.size;
      count += 1;
      accepted.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${accepted.length}-${Date.now()}`,
        file,
        preview: URL.createObjectURL(file),
      });
    }
    setValidation(message);
    if (accepted.length) setImages(current => [...current, ...accepted]);
  }
  function removeImage(key: string) {
    setImages(current => {
      const removed = current.find(item => item.key === key);
      if (removed) URL.revokeObjectURL(removed.preview);
      return current.filter(item => item.key !== key);
    });
    setValidation("");
  }
  return (
    <Modal
      error={error}
      title="把事情放下。"
      description="文字、截图或图片，先放下再安排。"
      onClose={onClose}
    >
      <form
        className="ui-form"
        onSubmit={async event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setValidation("");
          try {
            await onSubmit(String(data.get("request")), images.map(item => item.file), handling);
          } catch {
            /* The parent keeps the draft and reports the actual error. */
          }
        }}
      >
        <ChoiceGroup label="这件事怎么安排" value={handling} onChange={setHandling} disabled={busy}
          options={[{ value: "later", label: "先记下" }, { value: "self", label: "我来做" }, { value: "concierge", label: "交给管家" }]} />
        <p className="ui-form__note" aria-live="polite">{handling === "later" ? "只记录，不启动 Agent。准备好再开始。" : handling === "self" ? "由你执行，做完直接标记完成。" : "现在交给管家协调，由独立负责人执行。"}</p>
        <Field
          label={handling === "concierge" ? "要交给管家的事情" : "记下这件事"}
          htmlFor="goal-intake-input"
          connect={false}
          error={validation}
        >
        <div
          className={`goal-intake-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={event => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragOver={event => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={event => {
            event.preventDefault();
            setDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <TextArea
            id="goal-intake-input"
            className="goal-intake"
            name="request"
            required
            autoFocus
            maxLength={20000}
            rows={5}
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? "goal-intake-input-message" : undefined}
            placeholder={handling === "concierge" ? "直接说：要做什么、知道哪些背景、怎样算完成…" : "想到什么就记下，不必现在想清楚…"}
            onPaste={event => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              addFiles(files);
              if (!event.clipboardData.getData("text/plain").trim()) event.preventDefault();
            }}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="goal-intake-tools">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()} icon={<ImagePlus size={14} />}>
              添加图片
            </Button>
            <span>{images.length ? `${images.length}/8 张 · 可直接在输入框粘贴或拖入` : "可粘贴截图、拖入图片，或从本机选择"}</span>
          </div>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            aria-label="选择图片"
            onChange={event => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        </div>
        </Field>
        {images.length > 0 && (
          <div className="intake-attachments" aria-label="待提交图片">
            {images.map(item => (
              <figure className="intake-attachment" key={item.key}>
                <img src={item.preview} alt={item.file.name} />
                <figcaption>
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <span>{formatBytes(item.file.size)}</span>
                </figcaption>
                <button type="button" aria-label={`移除图片 ${item.file.name}`} disabled={busy} onClick={() => removeImage(item.key)}>
                  <Trash2 size={13} />
                </button>
              </figure>
            ))}
          </div>
        )}
        <p className="ui-form__note">图片只保存在本机，目标结束 30 天后自动清理。⌘ / Ctrl + Enter 提交。</p>
        {busy && <LoadingState label={handling === "concierge" ? "正在保存并联系管家…" : "正在保存…"} />}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" aria-label={handling === "concierge" ? "确认交给管家" : handling === "later" ? "确认先记下" : "确认我来做"} variant="primary" disabled={busy} icon={<Sparkles size={15} />}>
            {busy ? "正在保存…" : handling === "later" ? "先记下" : handling === "self" ? "记到我来做" : "交给管家"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
