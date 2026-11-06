/** Places API (New), using the same input in Safari, the app and desktop. */
export class PlaceSuggestions {
  private version = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private session?: google.maps.places.AutocompleteSessionToken;
  private readonly results = document.createElement('div');
  private readonly status = document.createElement('p');

  constructor(
    private input: HTMLInputElement,
    private choose: (lat: number, lng: number, label: string) => void
  ) {
    this.results.className = 'place-suggestions';
    this.results.setAttribute('aria-label', 'Suggested places');
    this.status.className = 'place-suggestions__status';
    this.status.setAttribute('role', 'status');
    input.parentElement!.after(this.status, this.results);
    input.addEventListener('input', this.onInput);
    input.addEventListener('keydown', this.onKey);
    this.results.addEventListener('keydown', this.onResultKey);
  }

  reset(): void {
    this.version++;
    clearTimeout(this.timer);
    this.session = undefined;
    this.results.replaceChildren();
    this.status.textContent = '';
  }

  dispose(): void {
    this.reset();
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKey);
    this.results.removeEventListener('keydown', this.onResultKey);
    this.results.remove();
    this.status.remove();
  }

  private readonly onInput = () => {
    const version = ++this.version;
    clearTimeout(this.timer);
    this.results.replaceChildren();
    const query = this.input.value.trim();
    this.status.textContent = query.length >= 2 ? 'Searching places…' : '';
    if (query.length >= 2)
      this.timer = setTimeout(() => void this.search(query, version), 220);
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.results.querySelector<HTMLButtonElement>('button')?.click();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.results.querySelector<HTMLButtonElement>('button')?.focus();
    }
  };

  private readonly onResultKey = (event: KeyboardEvent) => {
    const button = event.target as HTMLElement;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? button.nextElementSibling
          : button.previousElementSibling;
      (next as HTMLElement | null)?.focus();
      if (!next && event.key === 'ArrowUp') this.input.focus();
    }
  };

  private async search(input: string, version: number): Promise<void> {
    try {
      const { AutocompleteSessionToken, AutocompleteSuggestion } =
        (await google.maps.importLibrary(
          'places'
        )) as google.maps.PlacesLibrary;
      if (version !== this.version) return;
      this.session ??= new AutocompleteSessionToken();
      const { suggestions } =
        await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          sessionToken: this.session,
          locationBias: { north: 40.7, south: 40.1, west: -80.4, east: -79.6 }
        });
      if (version !== this.version) return;
      for (const suggestion of suggestions.slice(0, 5)) {
        const prediction = suggestion.placePrediction;
        if (!prediction) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.placeResult = '';
        button.textContent = prediction.text.toString();
        button.addEventListener(
          'click',
          () => void this.select(prediction, version)
        );
        this.results.append(button);
      }
      this.status.textContent = this.results.childElementCount
        ? 'Choose a place'
        : 'No places found. Try a street or a longer name.';
    } catch {
      if (version === this.version)
        this.status.textContent =
          'Place search is unavailable. Try again, or go back to use the map center.';
    }
  }

  private async select(
    prediction: google.maps.places.PlacePrediction,
    version: number
  ): Promise<void> {
    if (version !== this.version) return;
    const selection = ++this.version;
    this.results.replaceChildren();
    this.status.textContent = 'Opening place…';
    try {
      const place = prediction.toPlace();
      await place.fetchFields({
        fields: ['location', 'displayName', 'formattedAddress']
      });
      if (selection !== this.version) return;
      if (!place.location) throw new Error('Place has no coordinates');
      this.session = undefined;
      this.choose(
        place.location.lat(),
        place.location.lng(),
        place.displayName ||
          place.formattedAddress ||
          prediction.text.toString()
      );
    } catch {
      if (selection === this.version)
        this.status.textContent =
          'Could not open this place. Edit the search to try again.';
    }
  }
}
