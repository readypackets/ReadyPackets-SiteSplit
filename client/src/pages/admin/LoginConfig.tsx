/**
 * Admin Login Page Configurator.
 * Allows customising the login page hero, testimonial, and feature list.
 */
import { useState, useEffect } from "react";
import { Save, Eye, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/Button";
import { FieldShell, Input, Select, Textarea } from "@/components/ui/Field";
import { Card, CardHeader, Alert, Skeleton } from "@/components/ui/Surface";
import { PageHeader } from "@/components/layout/PortalLayout";
import { useToast } from "@/components/ui/Toast";
import { DEFAULT_LOGIN_SLIDES, type LoginSlideshowImageKey, type LoginSlideshowSlide } from "@shared/loginSlideshow";

const BACKGROUND_STYLES = [
  { value: "default", label: "Default (white)" },
  { value: "gradient", label: "Gradient (teal to navy)" },
  { value: "dark", label: "Dark" },
  { value: "brand", label: "Brand (navy)" },
];

const SLIDE_IMAGE_OPTIONS = [
  { value: "full", label: "ReadyPackets wordmark" },
  { value: "mark", label: "ReadyPackets mark" },
  { value: "square", label: "ReadyPackets square lockup" },
];

export function AdminLoginConfig() {
  const toast = useToast();
  const utils = trpc.useUtils();

  const config = trpc.tier4.loginConfig.get.useQuery();
  const updateMut = trpc.tier4.loginConfig.update.useMutation({
    onSuccess: () => {
      utils.tier4.loginConfig.get.invalidate();
      toast.success("Saved", "Login page configuration updated.");
    },
    onError: (e) => toast.error("Error", e.message),
  });

  const [heroHeadline, setHeroHeadline] = useState("");
  const [heroSubheadline, setHeroSubheadline] = useState("");
  const [showTestimonial, setShowTestimonial] = useState(false);
  const [testimonialText, setTestimonialText] = useState("");
  const [testimonialAuthor, setTestimonialAuthor] = useState("");
  const [showFeatureList, setShowFeatureList] = useState(true);
  const [featureList, setFeatureList] = useState<string[]>([]);
  const [backgroundStyle, setBackgroundStyle] = useState("default");
  const [accentColor, setAccentColor] = useState("");
  const [slideshowSlides, setSlideshowSlides] = useState<LoginSlideshowSlide[]>([...DEFAULT_LOGIN_SLIDES]);

  useEffect(() => {
    if (!config.data) return;
    setHeroHeadline(config.data.heroHeadline ?? "");
    setHeroSubheadline(config.data.heroSubheadline ?? "");
    setShowTestimonial(config.data.showTestimonial);
    setTestimonialText(config.data.testimonialText ?? "");
    setTestimonialAuthor(config.data.testimonialAuthor ?? "");
    setShowFeatureList(config.data.showFeatureList);
    setFeatureList(config.data.featureList ?? []);
    setBackgroundStyle(config.data.backgroundStyle);
    setAccentColor(config.data.accentColor ?? "");
    setSlideshowSlides(config.data.slideshowSlides ?? [...DEFAULT_LOGIN_SLIDES]);
  }, [config.data]);

  const handleSave = () => {
    updateMut.mutate({
      heroHeadline: heroHeadline || null,
      heroSubheadline: heroSubheadline || null,
      showTestimonial,
      testimonialText: testimonialText || null,
      testimonialAuthor: testimonialAuthor || null,
      showFeatureList,
      featureList: featureList.filter(Boolean),
      backgroundStyle: backgroundStyle as "default" | "gradient" | "dark" | "brand",
      accentColor: accentColor || null,
      slideshowSlides,
    });
  };

  const addFeature = () => setFeatureList((prev) => [...prev, ""]);
  const removeFeature = (index: number) =>
    setFeatureList((prev) => prev.filter((_, i) => i !== index));
  const updateFeature = (index: number, value: string) =>
    setFeatureList((prev) => prev.map((item, i) => (i === index ? value : item)));
  const updateSlide = (index: number, patch: Partial<LoginSlideshowSlide>) =>
    setSlideshowSlides((current) => current.map((slide, currentIndex) => currentIndex === index ? { ...slide, ...patch } : slide));
  const addSlide = () => setSlideshowSlides((current) => [...current, { eyebrow: "ReadyPackets portal", title: "Your next step, in one place.", description: "Use your protected workspace to continue with confidence.", imageKey: "mark" }]);
  const removeSlide = (index: number) => setSlideshowSlides((current) => current.filter((_, currentIndex) => currentIndex !== index));

  if (config.isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <>
      <PageHeader
        title="Login page"
        description="Customise the sign-in page hero, testimonial, and feature highlights."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              leadingIcon={<Eye className="size-4" aria-hidden="true" />}
              onClick={() => window.open("/login", "_blank")}
            >
              Preview
            </Button>
            <Button
              onClick={handleSave}
              busy={updateMut.isPending}
              leadingIcon={<Save className="size-4" aria-hidden="true" />}
            >
              Save changes
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Hero section" />
          <div className="mt-4 space-y-4">
            <FieldShell label="Headline" help="Leave blank to use the default ReadyPackets tagline.">
              <Input
                value={heroHeadline}
                onChange={(e) => setHeroHeadline(e.target.value)}
                placeholder="Your business, built right."
                maxLength={255}
              />
            </FieldShell>
            <FieldShell label="Subheadline">
              <Textarea
                value={heroSubheadline}
                onChange={(e) => setHeroSubheadline(e.target.value)}
                placeholder="Sign in to access your packet portal."
                rows={3}
                maxLength={512}
              />
            </FieldShell>
            <FieldShell label="Background style">
              <Select
                value={backgroundStyle}
                onChange={(e) => setBackgroundStyle(e.target.value)}
                options={BACKGROUND_STYLES}
              />
            </FieldShell>
            <FieldShell label="Accent colour" help="CSS colour value, e.g. #1a3a5c. Leave blank for default.">
              <Input
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                placeholder="#1a3a5c"
                maxLength={32}
              />
            </FieldShell>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Desktop login slideshow" />
            <div className="mt-2 space-y-4">
              <p className="text-sm text-body">Configure up to five short highlights. Images are limited to approved ReadyPackets brand assets; remote images, HTML, scripts, and custom styles are not accepted.</p>
              {slideshowSlides.map((slide, index) => (
                <div key={`${slide.imageKey}-${index}`} className="rounded-lg border border-line p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-ink">Slide {index + 1}</p>
                    <Button variant="danger" size="sm" disabled={slideshowSlides.length <= 1} onClick={() => removeSlide(index)} leadingIcon={<Trash2 className="size-3.5" aria-hidden="true" />}>Remove</Button>
                  </div>
                  <div className="mt-3 space-y-3">
                    <FieldShell label="Eyebrow"><Input value={slide.eyebrow} maxLength={80} onChange={(event) => updateSlide(index, { eyebrow: event.target.value })} /></FieldShell>
                    <FieldShell label="Headline"><Input value={slide.title} maxLength={120} onChange={(event) => updateSlide(index, { title: event.target.value })} /></FieldShell>
                    <FieldShell label="Description"><Textarea value={slide.description} rows={3} maxLength={360} onChange={(event) => updateSlide(index, { description: event.target.value })} /></FieldShell>
                    <FieldShell label="ReadyPackets visual"><Select value={slide.imageKey} options={SLIDE_IMAGE_OPTIONS} onChange={(event) => updateSlide(index, { imageKey: event.target.value as LoginSlideshowImageKey })} /></FieldShell>
                  </div>
                </div>
              ))}
              {slideshowSlides.length < 5 ? <Button variant="outline" size="sm" onClick={addSlide} leadingIcon={<Plus className="size-4" aria-hidden="true" />}>Add slide</Button> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Feature list" />
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showFeatureList}
                  onChange={(e) => setShowFeatureList(e.target.checked)}
                  className="rounded"
                />
                Show feature list on login page
              </label>
              {showFeatureList && (
                <>
                  {featureList.map((item, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        value={item}
                        onChange={(e) => updateFeature(index, e.target.value)}
                        placeholder={`Feature ${index + 1}`}
                        maxLength={200}
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => removeFeature(index)}
                        leadingIcon={<Trash2 className="size-3.5" aria-hidden="true" />}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  {featureList.length < 10 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addFeature}
                      leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                    >
                      Add feature
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Testimonial" />
            <div className="mt-4 space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showTestimonial}
                  onChange={(e) => setShowTestimonial(e.target.checked)}
                  className="rounded"
                />
                Show testimonial on login page
              </label>
              {showTestimonial && (
                <>
                  <FieldShell label="Testimonial text">
                    <Textarea
                      value={testimonialText}
                      onChange={(e) => setTestimonialText(e.target.value)}
                      placeholder="ReadyPackets saved us weeks of legal back-and-forth..."
                      rows={4}
                      maxLength={1000}
                    />
                  </FieldShell>
                  <FieldShell label="Author">
                    <Input
                      value={testimonialAuthor}
                      onChange={(e) => setTestimonialAuthor(e.target.value)}
                      placeholder="Jane Smith, Founder of Acme Inc."
                      maxLength={128}
                    />
                  </FieldShell>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <Alert tone="info" title="Live preview">
          Changes take effect immediately after saving. Open the login page in a new tab to preview.
        </Alert>
      </div>
    </>
  );
}
