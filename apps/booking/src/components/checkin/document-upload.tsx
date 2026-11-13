'use client';

import { FileImage, FileText, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { buttonClass } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { errorMessage } from '@/lib/api-error';
import { api, bookingPath, upload } from '@/lib/browser-api';
import { cn } from '@/lib/cn';
import { formatFileSize } from '@/lib/format';
import type { CheckinFile } from '@/lib/types';

/** What the server takes, said here first so that a file that cannot be taken is not sent at all. */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 8;

export interface DocumentUploadProps {
  token: string;
  documents: CheckinFile[];
  setDocuments: Dispatch<SetStateAction<CheckinFile[]>>;
}

interface Problem {
  id: number;
  fileName: string;
  message: string;
}

function refusal(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) {
    return 'Only JPEG, PNG and WebP photos and PDF files are accepted.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_BYTES) return 'The file is larger than 8 MB.';
  return null;
}

/** Photos or scans of identity documents: sent as soon as they are chosen, one after another. */
export function DocumentUpload({ token, documents, setDocuments }: DocumentUploadProps) {
  const [sending, setSending] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const problemId = useRef(0);

  const fail = (fileName: string, message: string) => {
    problemId.current += 1;
    const id = problemId.current;
    setProblems((current) => [...current, { id, fileName, message }]);
  };

  const add = async (files: File[]) => {
    if (files.length === 0) return;
    setProblems([]);
    setSending((current) => [...current, ...files.map((file) => file.name)]);
    let held = documents.length;
    for (const file of files) {
      const refused =
        held >= MAX_DOCUMENTS
          ? `At most ${MAX_DOCUMENTS} documents can be added to a booking.`
          : refusal(file);
      if (refused) {
        fail(file.name, refused);
      } else {
        try {
          const saved = await upload<CheckinFile>(bookingPath(token, '/check-in/documents'), file);
          held += 1;
          setDocuments((current) => [...current, saved]);
        } catch (err) {
          fail(file.name, errorMessage(err));
        }
      }
      setSending((current) => {
        const at = current.indexOf(file.name);
        return at < 0 ? current : [...current.slice(0, at), ...current.slice(at + 1)];
      });
    }
  };

  const remove = async (document: CheckinFile) => {
    if (removing) return;
    setRemoving(document.id);
    setProblems([]);
    try {
      await api<void>(
        bookingPath(token, `/check-in/documents/${encodeURIComponent(document.id)}`),
        { method: 'DELETE' },
      );
      setDocuments((current) => current.filter((other) => other.id !== document.id));
    } catch (err) {
      fail(document.fileName, errorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void add([...event.dataTransfer.files]);
  };

  const full = documents.length >= MAX_DOCUMENTS;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          over ? 'border-ink-soft bg-sunken' : 'border-line-strong bg-canvas',
        )}
      >
        <Upload className="size-6 text-ink-faint" aria-hidden />
        <p className="text-[15px] text-ink-soft">
          <span className="hidden sm:inline">Drop photos or scans here, or </span>
          <span className="sm:hidden">Take a photo of each document, or </span>
          choose files from your device.
        </p>
        <input
          ref={input}
          id="checkin-files"
          type="file"
          multiple
          accept={ACCEPTED.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Emptied so that choosing the same file again is noticed.
            event.target.value = '';
            void add(files);
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={full}
          aria-describedby="checkin-files-hint"
          className={buttonClass('secondary')}
        >
          Choose files
        </button>
        <p id="checkin-files-hint" className="text-sm text-ink-faint">
          JPEG, PNG or WebP photos and PDF files, up to 8 MB each. {MAX_DOCUMENTS} files at most.
        </p>
      </div>

      <div role="alert" className="space-y-1.5 empty:hidden">
        {problems.map((problem) => (
          <FieldError key={problem.id}>
            {problem.fileName} was not added. {problem.message}
          </FieldError>
        ))}
      </div>

      {documents.length > 0 || sending.length > 0 ? (
        <ul
          aria-label="Documents added"
          className="divide-y divide-line rounded-xl border border-line text-[15px]"
        >
          {documents.map((document) => {
            const Icon = document.contentType === 'application/pdf' ? FileText : FileImage;
            return (
              <li key={document.id} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3">
                <Icon className="size-5 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{document.fileName}</span>
                  <span className="block text-sm text-ink-soft">
                    {formatFileSize(document.size)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => remove(document)}
                  aria-label={`Remove ${document.fileName}`}
                  aria-busy={removing === document.id || undefined}
                  className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 font-medium text-ink-soft hover:bg-sunken hover:text-danger-700"
                >
                  {removing === document.id ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-4" aria-hidden />
                  )}
                  Remove
                </button>
              </li>
            );
          })}
          {sending.map((fileName, index) => (
            <li
              key={`${index}:${fileName}`}
              className="flex min-h-14 items-center gap-3 px-3 text-ink-soft"
            >
              <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Adding {fileName}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p role="status" className="sr-only">
        {sending.length > 0
          ? `Adding ${sending.length === 1 ? 'a file' : `${sending.length} files`}`
          : `${documents.length === 1 ? '1 document' : `${documents.length} documents`} added`}
      </p>
    </div>
  );
}
