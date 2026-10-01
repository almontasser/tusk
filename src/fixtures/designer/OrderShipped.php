<?php

namespace App\Notifications;

use App\Filament\Resources\Orders\OrderResource;
use App\Models\Order;
use Filament\Actions\Action;
use Filament\Notifications\Notification as FilamentNotification;
use Filament\Support\Icons\Heroicon;
use Illuminate\Bus\Queueable;
use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Notifications\Notification;

class OrderShipped extends Notification
{
    use Queueable;

    public function __construct(public Order $record) {}

    public function via(object $notifiable): array
    {
        return ['database', 'mail'];
    }

    public function toDatabase(object $notifiable): array
    {
        return FilamentNotification::make()
            ->title(__('Order :number shipped', ['number' => $this->record->number]))
            ->body("Hi {$this->record->customer?->name}, it's on its way.")
            ->icon(Heroicon::OutlinedTruck)
            ->success()
            ->iconColor('primary')
            ->actions([
                Action::make('view')
                    ->label('View order')
                    ->url(OrderResource::getUrl('view', ['record' => $this->record]))
                    ->markAsRead(),
            ])
            ->getDatabaseMessage();
    }

    public function toMail(object $notifiable): MailMessage
    {
        return (new MailMessage)
            ->subject("Order {$this->record->number} shipped")
            ->greeting('Hello!')
            ->line('Your order is on its way.')
            ->action('View order', OrderResource::getUrl('view', ['record' => $this->record]))
            ->line('Thank you for shopping with us.')
            ->cc('orders@example.com');
    }
}
