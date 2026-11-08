import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { Button } from "../../ui/index.js";
import type { Goal } from "../../../../../packages/core/src/types.js";
import type { GoalDetailService } from "./goalService.js";

export type GoalReplyMode = "message" | "return" | "drop";
type ReplyImage = { key: string; file: File; preview: string };

const attachmentFormats = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const imageFile = (file: File) =>
  attachmentFormats.has(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);

export function GoalReplyComposer({
  goal,
  mode,
  busy,
  error,
  service,
  onClose,
  onComplete,
  heading,
  placeholder,
  note,
  submitLabel,
  successMessage,
  dismissible = true,
  autoFocus = true,
  inline = false,
  routeToConcierge = false,
  secondaryAction,
}: {
  goal: Goal;
  mode: GoalReplyMode;
  busy: boolean;
  error: string;
  service: GoalDetailService;
  onClose: () => void;
  onComplete: (receipt: string) => void;
  heading?: string;
  placeholder?: string;
  note?: string;
  submitLabel?: string;
  successMessage?: string;
  dismissible?: boolean;
  autoFocus?: boolean;
  inline?: boolean;
  routeToConcierge?: boolean;
  secondaryAction?: ReactNode;
}) {
  const [message, setMessage] = useState("");
  const [replyImages, setReplyImages] = useState<ReplyImage[]>([]);
  const [validation, setValidation] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(replyImages);
  imagesRef.current = replyImages;

  useEffect(
    () => () => {
      imagesRef.current.forEach((item) => URL.revokeObjectURL(item.preview));
    },
    [],
  );

  const acceptsImages = mode === "message";
  const toConcierge = goal.mode === "concierge" || routeToConcierge;
  const baseLabels = {
    message: {
      heading: toConcierge ? "回复管家" : "记录留言",
      placeholder: "直接说，不必套格式。你的原话会交给管家。",
      submit: toConcierge ? "交给管家" : "记录留言",
      note:
        toConcierge
          ? "你只描述情况；等待、推进、验收或结束由管家判断。"
          : "只写入当前目标记录",
    },
    return: {
      heading: "退回说明",
      placeholder: "说清哪里需要修改；管家会转给原负责人。",
      submit: "退回并交给管家",
      note: "退回是明确状态操作",
    },
    drop: {
      heading: "放弃目标",
      placeholder: "写下放弃这件事的原因；记录会保留下来。",
      submit: "确认放弃",
      note: "放弃后不会再联系管家；记录仍可查看",
    },
  }[mode];
  const labels = {
    ...baseLabels,
    heading: heading ?? baseLabels.heading,
    placeholder: placeholder ?? baseLabels.placeholder,
    submit: submitLabel ?? baseLabels.submit,
    note: note ?? baseLabels.note,
  };

  function clearImages() {
    replyImages.forEach((item) => URL.revokeObjectURL(item.preview));
    setReplyImages([]);
  }
  function addFiles(incoming: File[]) {
    if (!incoming.length || !acceptsImages) return;
    const supported = incoming.filter(imageFile);
    let messageText =
      supported.length < incoming.length
        ? "只支持 PNG、JPEG、WebP 和 GIF 图片。"
        : "";
    if (supported.some((file) => file.size > 10 * 1024 * 1024)) {
      setValidation("单张图片不能超过 10 MB。");
      return;
    }
    const accepted: ReplyImage[] = [];
    let total = replyImages.reduce((sum, item) => sum + item.file.size, 0);
    let count = replyImages.length;
    for (const file of supported) {
      if (count >= 8) {
        messageText = "每个目标最多添加 8 张图片。";
        break;
      }
      if (total + file.size > 30 * 1024 * 1024) {
        messageText = "图片总计不能超过 30 MB。";
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
    setValidation(messageText);
    if (accepted.length) setReplyImages((current) => [...current, ...accepted]);
  }
  function removeImage(key: string) {
    setReplyImages((current) => {
      const removed = current.find((item) => item.key === key);
      if (removed) URL.revokeObjectURL(removed.preview);
      return current.filter((item) => item.key !== key);
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = message.trim();
    if (!body) return;
    setValidation("");
    try {
      if (mode === "return") {
        await service.command({
          type: "goal.rework",
          goalId: goal.id,
          note: body,
        });
        onComplete("已退回，管家会带着你的原话继续协调");
        return;
      }
      if (mode === "drop") {
        await service.command({
          type: "goal.drop",
          goalId: goal.id,
          note: body,
        });
        onComplete("目标已放弃，记录仍可查看");
        return;
      }
      const inputs = await Promise.all(
        replyImages.map(async (image) => ({
          name: image.file.name,
          bytes: await image.file.arrayBuffer(),
        })),
      );
      const attachments = inputs.length
        ? await service.importAttachments(inputs)
        : [];
      await service.command({
        type: "goal.message",
        goalId: goal.id,
        text: body,
        ...(routeToConcierge ? { routeToConcierge: true } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      onComplete(successMessage ??
        (toConcierge
          ? "消息已交给管家；目标状态等待管家判断"
          : "留言已记录"),
      );
    } catch (reason) {
      setValidation(String(reason).replace(/^Error: /, ""));
    }
  }

  return (
    <form className={`goal-reply-composer ${inline ? "goal-reply-composer--inline" : ""}`} onSubmit={submit}>
      <div className="reply-composer-heading">
        <span>{labels.heading}</span>
        {dismissible && (
          <button type="button" onClick={onClose}>
            取消
          </button>
        )}
      </div>
      <div
        className={`goal-reply-box ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => {
          if (
            acceptsImages &&
            Array.from(event.dataTransfer.types).includes("Files")
          ) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          if (
            acceptsImages &&
            Array.from(event.dataTransfer.types).includes("Files")
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (acceptsImages) addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <textarea
          autoFocus={autoFocus}
          required
          maxLength={12000}
          value={message}
          aria-label={
            mode === "return"
              ? "退回说明"
              : mode === "drop"
                ? "放弃原因"
                : "发给管家的消息"
          }
          placeholder={labels.placeholder}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={(event) => {
            if (!acceptsImages) return;
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            addFiles(files);
            if (!event.clipboardData.getData("text/plain").trim()) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {acceptsImages && (
          <button
            type="button"
            className="reply-attach"
            aria-label="添加图片"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={16} />
          </button>
        )}
      </div>
      {acceptsImages && (
        <>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            aria-label="选择回复图片"
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          {!!replyImages.length && (
            <div className="reply-image-strip">
              {replyImages.map((image) => (
                <figure key={image.key}>
                  <img src={image.preview} alt={image.file.name} />
                  <figcaption>{image.file.name}</figcaption>
                  <button
                    type="button"
                    aria-label={`移除回复图片 ${image.file.name}`}
                    onClick={() => removeImage(image.key)}
                  >
                    <X size={12} />
                  </button>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
      {(validation || error) && (
        <p className="goal-inline-error" role="alert">
          {validation || error}
        </p>
      )}
      <div className="reply-composer-footer">
        <span>{labels.note}</span>
        <div className="reply-composer-actions">
          {secondaryAction}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !message.trim()}
            icon={<Send size={15} />}
          >
            {labels.submit}
          </Button>
        </div>
      </div>
    </form>
  );
}
